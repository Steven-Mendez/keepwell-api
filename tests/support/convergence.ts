import { randomUUID } from "node:crypto"

import fc from "fast-check"
import { expect } from "vitest"

import { loanPaymentId } from "../../src/core/domain/schema"
import type { testAuthApp } from "./auth"
import { categoryRow, syncClient } from "./sync"

// ADR 0005's property: whatever devices do offline and in whatever order they sync, once every
// device has synced twice, all of them hold exactly the server's state, no payment recorded
// anywhere is lost, and nothing deleted anywhere comes back.

type Row = Record<string, unknown> & { id: string; updated_at: string; deleted_at: string | null }
type Ev = { event_id: string; entity: string; entity_id: string; operation: string; payload: Row; created_at: string }
const LOAN = "11111111-1111-4111-8111-111111111111"
const DAY = 86_400_000

class Device {
  rows = new Map<string, Row>()
  outbox: Ev[] = []
  cursor = 0
  online = true
  private tick = 0

  constructor(
    readonly api: ReturnType<typeof syncClient>,
    private readonly clockOffsetMs: number
  ) {}

  private now() {
    // Each device's own clock: monotonic, possibly far ahead of the server's.
    return new Date(Date.now() - DAY + this.clockOffsetMs + ++this.tick * 1000).toISOString()
  }

  private record(entity: string, row: Row, operation: string) {
    this.rows.set(`${entity}:${row.id}`, row)
    this.outbox.push({ event_id: randomUUID(), entity, entity_id: row.id, operation, payload: row, created_at: row.updated_at })
  }

  editCategory(id: string, action: "save" | "delete", name: string) {
    const existing = this.rows.get(`category:${id}`)
    if (existing?.deleted_at) return // a local save never revives a deleted row
    const at = this.now()
    if (action === "delete") {
      if (existing) this.record("category", { ...existing, updated_at: at, deleted_at: at }, "delete")
      return
    }
    this.record("category", { ...categoryRow(id, name, at), created_at: (existing?.created_at as string) ?? at }, existing ? "update" : "create")
  }

  payInstallment(number: number, undo: boolean) {
    const id = loanPaymentId(LOAN, number)
    const existing = this.rows.get(`loanPayment:${id}`)
    if (existing?.deleted_at) return
    const at = this.now()
    if (undo) {
      if (existing) this.record("loanPayment", { ...existing, updated_at: at, deleted_at: at }, "delete")
      return
    }
    if (existing) return
    this.record("loanPayment", { id, loan_id: LOAN, number, paid_at: at, transaction_id: null, created_at: at, updated_at: at, deleted_at: null }, "create")
  }

  private pending(key: string) {
    return this.outbox.some((event) => `${event.entity}:${event.entity_id}` === key)
  }

  async sync() {
    if (!this.online) return
    const sent = this.outbox.splice(0, 200)
    if (sent.length > 0) {
      const { body } = await this.api.push(sent)
      for (const result of body.results) {
        const event = sent.find((candidate) => candidate.event_id === result.event_id)!
        const key = `${event.entity}:${event.entity_id}`
        if (this.pending(key)) continue // a newer local change will be pushed and judged
        if (result.status === "applied" && result.updated_at) this.rows.set(key, { ...this.rows.get(key)!, updated_at: result.updated_at })
        if (result.current) this.rows.set(key, result.current as Row)
        if (result.status === "rejected") throw new Error(`unexpected rejection: ${result.reason}`)
      }
    }
    for (;;) {
      const { body } = await this.api.pull(this.cursor, 50)
      for (const change of body.changes) {
        const key = `${change.entity}:${change.entity_id}`
        if (!this.pending(key)) this.rows.set(key, change.row as Row)
      }
      this.cursor = body.next_cursor
      if (!body.has_more) break
    }
  }
}

const op = fc.oneof(
  fc.record({ kind: fc.constant("category" as const), device: fc.nat(2), id: fc.constantFrom("groceries", "rent", "fun"), action: fc.constantFrom("save", "save", "delete") as fc.Arbitrary<"save" | "delete">, name: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant("pay" as const), device: fc.nat(2), number: fc.integer({ min: 1, max: 4 }), undo: fc.boolean() }),
  fc.record({ kind: fc.constant("sync" as const), device: fc.nat(2) }),
  fc.record({ kind: fc.constant("network" as const), device: fc.nat(2) })
)

/**
 * The property itself, shared by this suite (local Postgres) and tests/remote (the dev cluster).
 * `freshUser` gives each case its own signed-in account.
 */
export function convergenceProperty(freshUser: () => Promise<{ http: ReturnType<typeof testAuthApp>["app"]; cookie: string }>) {
  return fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 40 }), async (ops) => {
          const { http, cookie } = await freshUser()
          // The third device's clock runs two days ahead.
          const devices = [0, 0, 2 * DAY].map((offset) => new Device(syncClient(http, cookie), offset))
          const everPaid = new Set<string>()
          const everDeleted = new Set<string>()

          for (const step of ops) {
            const device = devices[step.device]!
            if (step.kind === "category") device.editCategory(step.id, step.action, step.name)
            if (step.kind === "pay") device.payInstallment(step.number, step.undo)
            if (step.kind === "sync") await device.sync()
            if (step.kind === "network") device.online = !device.online
            for (const [key, row] of device.rows) {
              if (key.startsWith("loanPayment:") && !row.deleted_at) everPaid.add(key)
            }
            for (const event of device.outbox) if (event.operation === "delete") everDeleted.add(`${event.entity}:${event.entity_id}`)
          }

          for (const device of devices) device.online = true
          for (let round = 0; round < 2; round++) for (const device of devices) await device.sync()

          const server = new Map<string, Row>()
          for (const entity of ["category", "loanPayment"]) {
            for (const row of (await devices[0]!.api.snapshot(entity)).body.rows as Row[]) server.set(`${entity}:${row.id}`, row)
          }
          for (const device of devices) {
            expect(device.outbox).toEqual([])
            expect(Object.fromEntries(device.rows)).toEqual(Object.fromEntries(server))
          }
          for (const key of everDeleted) expect(server.get(key)?.deleted_at, `${key} came back`).toBeTruthy()
          for (const key of everPaid) expect(server.has(key), `${key} was lost`).toBe(true)
  })
}

