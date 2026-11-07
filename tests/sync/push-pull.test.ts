import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { CLOSED_PLANS } from "../../src/core/capabilities"
import { adminDatabase, appDatabase } from "../support/database"
import { signIn, testAuthApp } from "../support/auth"
import { categoryRow, event, syncClient, transactionRow, wipe } from "../support/sync"

const T0 = "2026-11-01T10:00:00.000Z"
const T1 = "2026-11-01T11:00:00.000Z"
const T2 = "2026-11-01T12:00:00.000Z"

describe("sync push, pull and snapshot", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function setup(sub = "000001.author") {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, sub)
    return { http, cookie }
  }

  it("applies a batch, answers a resend with the same results, and serves it to another device", async () => {
    const { http, cookie } = await setup()
    const phone = syncClient(http, cookie)
    const web = syncClient(http, cookie)
    const batch = [event("category", categoryRow("groceries", "Super", T0), "create"), event("transaction", transactionRow(randomUUID(), T0), "create")]
    const first = await phone.push(batch)
    expect(first.status).toBe(200)
    expect(first.body.results.map((r) => [r.status, r.server_seq])).toEqual([["applied", 1], ["applied", 2]])
    const again = await phone.push(batch)
    expect(again.body.results.map((r) => [r.event_id, r.status, r.server_seq])).toEqual(first.body.results.map((r) => [r.event_id, r.status, r.server_seq]))
    expect(again.body.results[0]).toMatchObject({ current: { name: "Super" } })
    expect((await admin.db.execute(sql`select count(*)::int as n from change_log`)).rows[0]).toEqual({ n: 2 })

    const pulled = await web.pull(0)
    expect(pulled.body.changes.map((c) => c.entity)).toEqual(["category", "transaction"])
    expect(pulled.body.next_cursor).toBe(2)
    expect(pulled.body.has_more).toBe(false)
    // The device gets its own changes too: applying them is harmless and keeps the order intact.
    expect((await phone.pull(0)).body.changes.map((c) => c.server_seq)).toEqual([1, 2])
  })

  it("rejects an invalid event on its own and applies the rest", async () => {
    const { http, cookie } = await setup()
    const client = syncClient(http, cookie)
    const bad = event("transaction", transactionRow(randomUUID(), T0, { amount: 12.5 }), "create")
    const good = event("category", categoryRow("groceries", "Super", T0), "create")
    const { body } = await client.push([bad, good])
    expect(body.results[0]).toMatchObject({ status: "rejected" })
    expect(body.results[0]!.reason).toContain("amount")
    expect(body.results[1]).toMatchObject({ status: "applied", server_seq: 1 })
  })

  it("lets the later of two equal timestamps win, in arrival order", async () => {
    const { http, cookie } = await setup()
    const client = syncClient(http, cookie)
    await client.push([event("category", categoryRow("groceries", "First", T1), "create")])
    expect((await client.push([event("category", categoryRow("groceries", "Second", T1))])).body.results[0]!.status).toBe("applied")
  })

  it("lets the later update win and marks the older one stale", async () => {
    const { http, cookie } = await setup()
    const client = syncClient(http, cookie)
    await client.push([event("category", categoryRow("groceries", "Super", T1), "create")])
    const { body } = await client.push([event("category", categoryRow("groceries", "Older", T0))])
    expect(body.results[0]).toMatchObject({ status: "stale", reason: "older_than_stored", current: { name: "Super" } })
    const snapshot = await client.snapshot("category")
    expect(snapshot.body.rows[0]).toMatchObject({ name: "Super" })
  })

  it("never revives a deleted row (delete wins)", async () => {
    const { http, cookie } = await setup()
    const client = syncClient(http, cookie)
    await client.push([event("category", categoryRow("groceries", "Super", T0), "create")])
    await client.push([event("category", categoryRow("groceries", "Super", T1, true))])
    const revive = await client.push([event("category", categoryRow("groceries", "Back", T2))])
    expect(revive.body.results[0]).toMatchObject({ status: "stale", reason: "tombstone_is_final" })
    expect((await client.snapshot("category")).body.rows[0]).toMatchObject({ deleted_at: T1 })
  })

  it("caps an updated_at from the future at the server's clock", async () => {
    const { http, cookie } = await setup()
    const client = syncClient(http, cookie)
    await client.push([event("category", categoryRow("groceries", "From 2099", "2099-01-01T00:00:00.000Z"), "create")])
    const stored = (await client.snapshot("category")).body.rows[0]!
    expect((stored.updated_at as string) < "2099-01-01T00:00:00.000Z").toBe(true)
    // So a normal device can still win afterwards.
    const later = new Date(Date.now() + 1000).toISOString()
    expect((await client.push([event("category", categoryRow("groceries", "Fixed", later))])).body.results[0]!.status).toBe("applied")
  })

  it("keeps source as the server set it, whatever the client claims", async () => {
    const { http, cookie } = await setup()
    const client = syncClient(http, cookie)
    const id = randomUUID()
    await client.push([event("transaction", transactionRow(id, T0, { source: "mcp" }), "create")])
    expect((await client.snapshot("transaction")).body.rows[0]).toMatchObject({ source: "app" })
    await admin.db.execute(sql`update transactions set source = 'mcp' where id = ${id}`)
    await client.push([event("transaction", transactionRow(id, T1, { status: "confirmed" }))])
    expect((await client.snapshot("transaction")).body.rows[0]).toMatchObject({ source: "mcp", updated_at: T1 })
  })

  it("keeps users apart: the same ids, nothing crosses", async () => {
    const ana = await setup("000001.author")
    const ben = await setup("000002.second")
    await syncClient(ana.http, ana.cookie).push([event("category", categoryRow("groceries", "Ana's", T0), "create")])
    await syncClient(ben.http, ben.cookie).push([event("category", categoryRow("groceries", "Ben's", T0), "create")])
    expect((await syncClient(ana.http, ana.cookie).pull(0)).body.changes.map((c) => c.row.name)).toEqual(["Ana's"])
    expect((await syncClient(ben.http, ben.cookie).snapshot("category")).body.rows.map((r) => r.name)).toEqual(["Ben's"])
  })

  it("pages the snapshot by id with the sequence it reflects", async () => {
    const { http, cookie } = await setup()
    const client = syncClient(http, cookie)
    await client.push(["a", "b", "c"].map((id) => event("category", categoryRow(id, id, T0), "create")))
    const first = await client.snapshot("category", "", 2)
    expect(first.body).toMatchObject({ server_seq: 3, next_after: "b" })
    expect((await client.snapshot("category", "b", 2)).body).toMatchObject({ rows: [{ id: "c" }], next_after: null })
  })

  it("serializes two concurrent pushes of the same user without losing or reusing a sequence", async () => {
    const { http, cookie } = await setup()
    const one = syncClient(http, cookie)
    const two = syncClient(http, cookie)
    const batch = (prefix: string) => Array.from({ length: 20 }, (_, i) => event("category", categoryRow(`${prefix}-${i}`, prefix, T0), "create"))
    const [a, b] = await Promise.all([one.push(batch("one")), two.push(batch("two"))])
    const seqs = [...a.body.results, ...b.body.results].map((r) => r.server_seq!).sort((x, y) => x - y)
    expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    expect((await syncClient(http, cookie).pull(0)).body.changes).toHaveLength(40)
  })

  it("answers with what committed when time runs out", async () => {
    let now = 0
    const { app: http } = testAuthApp(app.db, {}, { clock: () => (now += 15_000) })
    const { cookie } = await signIn(http, "000001.author")
    const events = Array.from({ length: 120 }, (_, i) => event("category", categoryRow(`c-${i}`, "x", T0), "create"))
    const { body } = await syncClient(http, cookie).push(events)
    expect(body.partial).toBe(true)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results.length).toBeLessThan(120)
  })

  it("refuses sync without the capability, after authentication", async () => {
    const { app: http } = testAuthApp(app.db, {}, { plans: () => CLOSED_PLANS })
    const { cookie } = await signIn(http, "000001.author")
    const res = await syncClient(http, cookie).push([])
    expect(res.status).toBe(403)
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe("needs_plan")
    expect((await http.request("/sync/pull?client_id=" + randomUUID())).status).toBe(401)
  })
})
