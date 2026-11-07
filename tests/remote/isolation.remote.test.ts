import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { APP_ROLE, createDatabase } from "../../src/adapters/database/client"
import { scopedDb } from "../../src/adapters/database/scoped-db"
import { categories, changeLog } from "../../src/adapters/database/sync-tables"

// Against the dev cluster, as the API's own role: isolation and immutable history hold on DSQL,
// not only on local Postgres. Users are fresh random ids; nothing assumes an empty database.
describe("dev cluster: isolation and immutable history", () => {
  const app = createDatabase({ kind: "dsql", host: process.env.DB_HOST!, user: APP_ROLE, region: process.env.AWS_REGION })
  afterAll(() => app.close())
  const at = new Date().toISOString()
  const row = (name: string) => ({ id: "groceries", name, kind: "expense", icon: null, color: null, is_renamed: false, sort_index: 0, budget_amount: null, budget_currency: null, created_at: at, updated_at: at, deleted_at: null })

  it("keeps two users apart on the same id", async () => {
    const ana = scopedDb(app.db, `test-${randomUUID()}`)
    const ben = scopedDb(app.db, `test-${randomUUID()}`)
    await ana.insert(categories, [row("Super")])
    expect(await ben.select(categories, eq(categories.id, "groceries"))).toEqual([])
    expect(await ben.update(categories, { name: "pwned" }, eq(categories.id, "groceries"))).toBe(0)
    expect((await ana.select(categories))[0]!.name).toBe("Super")
  })

  it("refuses UPDATE and DELETE on change_log for the API role", async () => {
    const ana = scopedDb(app.db, `test-${randomUUID()}`)
    await ana.insert(changeLog, [{ server_seq: 1, entity: "category", entity_id: "groceries", operation: "create", payload: "{}", status: "applied", client_id: "c", event_id: randomUUID() }])
    await expect(ana.update(changeLog, { status: "stale" }, eq(changeLog.server_seq, 1))).rejects.toThrow()
    await expect(ana.delete(changeLog, eq(changeLog.server_seq, 1))).rejects.toThrow()
  })
})
