import { eq, sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { fromStored, toStored } from "../../src/adapters/database/ledger-rows"
import { DrizzleReconciliationSource } from "../../src/adapters/database/reconciliation-source"
import { scopedDb } from "../../src/adapters/database/scoped-db"
import { categories, changeLog, LEDGER_TABLES, transactions } from "../../src/adapters/database/sync-tables"
import sync from "../../src/core/domain/fixtures/sync.json"
import { SYNC_ENTITIES } from "../../src/core/domain/schema"
import { Reconcile } from "../../src/core/use-cases/reconcile"
import { adminDatabase, appDatabase } from "../support/database"

const at = "2026-11-01T18:00:00.000Z"
const groceries = (name: string) => ({ id: "groceries", name, kind: "expense", icon: null, color: null, is_renamed: false, sort_index: 0, budget_amount: null, budget_currency: null, created_at: at, updated_at: at, deleted_at: null })

describe("user isolation through scopedDb", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(async () => {
    for (const table of ["categories", "transactions", "change_log"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  const ana = () => scopedDb(app.db, "user-ana")
  const ben = () => scopedDb(app.db, "user-ben")

  it("lets two users hold the same id without seeing each other's row", async () => {
    await ana().insert(categories, [groceries("Super")])
    await ben().insert(categories, [groceries("Mercado")])
    expect((await ana().select(categories)).map((r) => r.name)).toEqual(["Super"])
    expect((await ben().select(categories)).map((r) => r.name)).toEqual(["Mercado"])
  })

  it("never lets one user read, change or delete another's row by id", async () => {
    await ana().insert(categories, [groceries("Super")])
    expect(await ben().select(categories, eq(categories.id, "groceries"))).toEqual([])
    expect(await ben().update(categories, { name: "pwned" }, eq(categories.id, "groceries"))).toBe(0)
    expect(await ben().delete(categories, eq(categories.id, "groceries"))).toBe(0)
    expect((await ana().select(categories))[0]!.name).toBe("Super")
  })

  it("ignores a user_id smuggled in the data", async () => {
    await ben().insert(categories, [{ ...groceries("Smuggled"), user_id: "user-ana" }])
    expect(await ana().select(categories)).toEqual([])
    await ana().insert(categories, [groceries("Super")])
    await ben().update(categories, { user_id: "user-ben" }, eq(categories.id, "groceries"))
    expect(await ana().select(categories)).toHaveLength(1)
  })

  it("refuses to run without a user", () => {
    expect(() => scopedDb(app.db, "")).toThrow()
  })

  it("stores every valid fixture row and reads it back byte for byte", async () => {
    for (const { event } of sync.valid) {
      const entity = event.entity as (typeof SYNC_ENTITIES)[number]
      const { user_id: _u, server_seq: _s, ...row } = event.payload as Record<string, unknown>
      const scoped = scopedDb(app.db, `user-${event.event_id}-${entity}-${Math.random()}`)
      await scoped.insert(LEDGER_TABLES[entity], [toStored(entity, row)])
      const [stored] = await scoped.select(LEDGER_TABLES[entity])
      const back = fromStored(entity, stored!)
      for (const [column, value] of Object.entries(row)) expect(back[column], `${entity}.${column}`).toEqual(value)
    }
  })
})

describe("immutable history", () => {
  const app = appDatabase()
  afterAll(() => app.close())

  it("the API role can append to change_log but never rewrite or erase it", async () => {
    const ana = scopedDb(app.db, "user-ana")
    await ana.insert(changeLog, [{ server_seq: 1, entity: "category", entity_id: "groceries", operation: "create", payload: "{}", status: "applied", client_id: "c", event_id: "e1" }])
    await expect(ana.update(changeLog, { status: "stale" }, eq(changeLog.server_seq, 1))).rejects.toThrow()
    await expect(ana.delete(changeLog, eq(changeLog.server_seq, 1))).rejects.toThrow()
  })
})

describe("reconciliation", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(async () => {
    for (const table of ["categories", "transactions", "change_log"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  it("finds nothing when the tables are the replay of the log, and names what differs otherwise", async () => {
    const ana = scopedDb(app.db, "user-ana")
    const v1 = groceries("Super")
    const v2 = { ...v1, name: "Supermercado", updated_at: "2026-11-02T00:00:00.000Z" }
    await ana.insert(changeLog, [
      { server_seq: 1, entity: "category", entity_id: "groceries", operation: "create", payload: JSON.stringify(v1), status: "applied", client_id: "c", event_id: "e1" },
      { server_seq: 2, entity: "category", entity_id: "groceries", operation: "update", payload: JSON.stringify(v2), status: "applied", client_id: "c", event_id: "e2" },
    ])
    await ana.insert(categories, [toStored("category", v2)])
    const reconcile = new Reconcile(new DrizzleReconciliationSource(admin.db))
    expect((await reconcile.execute(["user-ana"])).discrepancies).toEqual([])

    // A write that bypassed the log.
    await admin.db.execute(sql`update categories set name = 'tampered' where user_id = 'user-ana'`)
    await scopedDb(admin.db, "user-ana").insert(transactions, [])
    const result = await reconcile.execute(["user-ana"])
    expect(result.discrepancies).toEqual([{ userId: "user-ana", key: "category:groceries", kind: "different", columns: ["name"] }])
  })
})
