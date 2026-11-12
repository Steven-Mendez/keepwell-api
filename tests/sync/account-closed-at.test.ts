import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { AccountWire } from "../../src/core/domain/schema"
import { signIn, testAuthApp } from "../support/auth"
import { adminDatabase, appDatabase } from "../support/database"
import { event, syncClient, wipe } from "../support/sync"

const T0 = "2026-11-01T10:00:00.000Z"
const T1 = "2026-11-01T11:00:00.000Z"
const T2 = "2026-11-01T12:00:00.000Z"
const ID = "11111111-1111-4111-8111-111111111111"
const CLOSED = "2026-11-01T09:30:00.000Z"

/** The account row as an app that predates `closed_at` builds it: the key isn't there at all. */
function oldAppAccount(at: string, name = "Ahorro") {
  return { id: ID, name, bank: "BAC", kind: "deposit", opening_balances: [{ amount: "0", currency: "USD" }], opening_date: "2026-01-01T12:00:00.000Z", debt_mode: null, limit_amount: null, limit_currency: null, cutoff_day: null, due_day: null, created_at: T0, updated_at: at, deleted_at: null }
}

function newAppAccount(at: string, closedAt: string | null, name = "Ahorro") {
  return { ...oldAppAccount(at, name), closed_at: closedAt }
}

/** What an app older than the column validates a pulled account row with. */
const OldAccountWire = AccountWire.omit({ closed_at: true })

describe("a closed account and apps that predate closing (receta, paso 4)", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function devices() {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    return { phone: syncClient(http, cookie), old: syncClient(http, cookie), web: syncClient(http, cookie) }
  }

  it("an old app ignores the closing it receives", async () => {
    const { phone, old } = await devices()
    await phone.push([event("account", newAppAccount(T0, CLOSED), "create")])
    const pulled = (await old.pull(0)).body.changes.at(-1)!.row
    expect(pulled.closed_at).toBe(CLOSED)
    const parsed = OldAccountWire.safeParse(pulled)
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty("closed_at")
  })

  it("an old app renaming the account keeps it closed, in the database and for every other device", async () => {
    const { phone, old, web } = await devices()
    await phone.push([event("account", newAppAccount(T0, CLOSED), "create")])

    const resent = await old.push([event("account", oldAppAccount(T1, "Ahorro viejo"))])
    expect(resent.body.results[0]).toMatchObject({ status: "applied" })

    const [stored] = (await admin.db.execute(sql`select name, closed_at from ledger_accounts`)).rows
    expect(stored).toEqual({ name: "Ahorro viejo", closed_at: CLOSED })

    const changes = (await web.pull(0)).body.changes.filter((change) => change.entity === "account")
    expect(changes.at(-1)!.row).toMatchObject({ name: "Ahorro viejo", closed_at: CLOSED })
    const [logged] = (await admin.db.execute(sql`select payload from change_log order by server_seq desc limit 1`)).rows
    expect(JSON.parse(logged!.payload as string)).toMatchObject({ name: "Ahorro viejo", closed_at: CLOSED })

    expect((await web.snapshot("account")).body.rows[0]).toMatchObject({ name: "Ahorro viejo", closed_at: CLOSED })
  })

  it("closed_at null from a newer app reopens it", async () => {
    const { phone, web } = await devices()
    await phone.push([event("account", newAppAccount(T0, CLOSED), "create")])
    await web.push([event("account", newAppAccount(T2, null))])
    expect((await admin.db.execute(sql`select closed_at from ledger_accounts`)).rows[0]).toEqual({ closed_at: null })
  })
})
