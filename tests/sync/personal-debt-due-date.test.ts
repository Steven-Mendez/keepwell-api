import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { PersonalDebtWire } from "../../src/core/domain/schema"
import { signIn, testAuthApp } from "../support/auth"
import { adminDatabase, appDatabase } from "../support/database"
import { event, syncClient, wipe } from "../support/sync"

const T0 = "2026-11-01T10:00:00.000Z"
const T1 = "2026-11-01T11:00:00.000Z"
const T2 = "2026-11-01T12:00:00.000Z"
const ID = "55555555-5555-4555-8555-555555555555"
const DUE = "2026-11-15T06:00:00.000Z"

/** The debt row as an app that predates `due_date` builds it: the key isn't there at all. */
function oldAppDebt(at: string, note: string | null = null) {
  return { id: ID, person: "Ana", direction: "theyOweMe", amount: "12", currency: "USD", date: "2026-09-01T18:00:00.000Z", note, settled_at: null, transaction_id: null, created_at: T0, updated_at: at, deleted_at: null }
}

function newAppDebt(at: string, dueDate: string | null, note: string | null = null) {
  return { ...oldAppDebt(at, note), due_date: dueDate }
}

/** What an app older than the column validates a pulled debt row with. */
const OldPersonalDebtWire = PersonalDebtWire.omit({ due_date: true })

describe("personal debt due date and apps that predate it (receta, paso 4)", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function devices() {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    return { phone: syncClient(http, cookie), old: syncClient(http, cookie), web: syncClient(http, cookie) }
  }

  it("an old app ignores the due date it receives", async () => {
    const { phone, old } = await devices()
    await phone.push([event("personalDebt", newAppDebt(T0, DUE), "create")])
    const pulled = (await old.pull(0)).body.changes.at(-1)!.row
    expect(pulled.due_date).toBe(DUE)
    const parsed = OldPersonalDebtWire.safeParse(pulled)
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty("due_date")
  })

  it("an old app resending the debt keeps the due date, in the database and for every other device", async () => {
    const { phone, old, web } = await devices()
    await phone.push([event("personalDebt", newAppDebt(T0, DUE), "create")])

    const resent = await old.push([event("personalDebt", oldAppDebt(T1, "Dinner"))])
    expect(resent.body.results[0]).toMatchObject({ status: "applied" })

    const [stored] = (await admin.db.execute(sql`select note, due_date from personal_debts`)).rows
    expect(stored).toEqual({ note: "Dinner", due_date: DUE })

    const changes = (await web.pull(0)).body.changes.filter((change) => change.entity === "personalDebt")
    expect(changes.at(-1)!.row).toMatchObject({ note: "Dinner", due_date: DUE })
    const [logged] = (await admin.db.execute(sql`select payload from change_log order by server_seq desc limit 1`)).rows
    expect(JSON.parse(logged!.payload as string)).toMatchObject({ note: "Dinner", due_date: DUE })

    expect((await web.snapshot("personalDebt")).body.rows[0]).toMatchObject({ note: "Dinner", due_date: DUE })
  })

  it("a newer app can change the due date, or remove it with null", async () => {
    const { phone, web } = await devices()
    await phone.push([event("personalDebt", newAppDebt(T0, DUE), "create")])
    await web.push([event("personalDebt", newAppDebt(T1, "2026-12-01T06:00:00.000Z"))])
    expect((await admin.db.execute(sql`select due_date from personal_debts`)).rows[0]).toEqual({ due_date: "2026-12-01T06:00:00.000Z" })
    await web.push([event("personalDebt", newAppDebt(T2, null))])
    expect((await admin.db.execute(sql`select due_date from personal_debts`)).rows[0]).toEqual({ due_date: null })
  })
})
