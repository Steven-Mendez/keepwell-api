import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { TransactionWire } from "../../src/core/domain/schema"
import { signIn, testAuthApp } from "../support/auth"
import { adminDatabase, appDatabase } from "../support/database"
import { event, syncClient, transactionRow, wipe } from "../support/sync"

const T0 = "2026-11-01T10:00:00.000Z"
const T1 = "2026-11-01T11:00:00.000Z"
const T2 = "2026-11-01T12:00:00.000Z"
const ID = "44444444-4444-4444-8444-444444444444"
const FIT = "FITID-2026110100042"

/** What an app older than the column (iOS today) validates a pulled movement with. */
const OldTransactionWire = TransactionWire.omit({ imported_id: true })

// T28, receta paso 4: the server keeps a movement's imported_id once set, like `source`, so iOS
// (which doesn't know the field) and older webs can edit an imported movement without clearing it.
describe("a movement's imported_id and apps that don't know it", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function devices() {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    return { web: syncClient(http, cookie), phone: syncClient(http, cookie), other: syncClient(http, cookie) }
  }

  async function stored() {
    return (await admin.db.execute(sql`select description, imported_id from transactions where id = ${ID}`)).rows[0]
  }

  async function logged() {
    const [row] = (await admin.db.execute(sql`select payload from change_log order by server_seq desc limit 1`)).rows
    return JSON.parse(row!.payload as string) as Record<string, unknown>
  }

  it("an old app reads the pulled row and ignores the field", async () => {
    const { web, phone } = await devices()
    await web.push([event("transaction", transactionRow(ID, T0, { imported_id: FIT }), "create")])
    const pulled = (await phone.pull(0)).body.changes.at(-1)!.row
    expect(pulled.imported_id).toBe(FIT)
    const parsed = OldTransactionWire.safeParse(pulled)
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty("imported_id")
  })

  for (const [name, resent] of [
    ["without the key (iOS today)", {}],
    ["with null", { imported_id: null }],
    ["with another id", { imported_id: "SOMETHING-ELSE" }],
  ] as const) {
    it(`an app that resends the row ${name} keeps the imported id, in the table and for every other device`, async () => {
      const { web, phone, other } = await devices()
      await web.push([event("transaction", transactionRow(ID, T0, { imported_id: FIT }), "create")])
      // The app rebuilds the row from what it knows, as iOS does: no imported_id.
      const row = transactionRow(ID, T1, { description: "Súper del mes", ...resent })
      const result = await phone.push([event("transaction", row)])
      expect(result.body.results[0]).toMatchObject({ status: "applied" })

      expect(await stored()).toEqual({ description: "Súper del mes", imported_id: FIT })
      expect(await logged()).toMatchObject({ description: "Súper del mes", imported_id: FIT })
      const changes = (await other.pull(0)).body.changes.filter((change) => change.entity === "transaction")
      expect(changes.at(-1)!.row).toMatchObject({ description: "Súper del mes", imported_id: FIT })
      expect((await other.snapshot("transaction")).body.rows[0]).toMatchObject({ description: "Súper del mes", imported_id: FIT })
    })
  }

  it("a movement that wasn't imported takes one later, and a delete keeps it on the tombstone", async () => {
    const { web, phone } = await devices()
    await web.push([event("transaction", transactionRow(ID, T0), "create")])
    expect(await stored()).toEqual({ description: "Supermercado", imported_id: null })
    await web.push([event("transaction", transactionRow(ID, T1, { imported_id: FIT }))])
    expect(await stored()).toMatchObject({ imported_id: FIT })
    await phone.push([event("transaction", transactionRow(ID, T2, { deleted_at: T2 }))])
    expect(await logged()).toMatchObject({ deleted_at: T2, imported_id: FIT })
  })
})
