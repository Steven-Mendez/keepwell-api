import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { PersonalDebtRepaymentWire } from "../../src/core/domain/schema"
import { signIn, testAuthApp } from "../support/auth"
import { adminDatabase, appDatabase } from "../support/database"
import { event, syncClient, wipe } from "../support/sync"

const T0 = "2026-11-01T10:00:00.000Z"
const T1 = "2026-11-01T11:00:00.000Z"
const T2 = "2026-11-01T12:00:00.000Z"
const ID = "77777777-7777-4777-8777-777777777777"
const DEBT = "55555555-5555-4555-8555-555555555555"
const DEPOSIT = "44444444-4444-4444-8444-444444444444"

/** The repayment row as an app that predates deposits builds it: the key isn't there at all. */
function oldAppRepayment(at: string, amount = "300") {
  return { id: ID, debt_id: DEBT, amount, date: "2026-11-05T18:00:00.000Z", created_at: T0, updated_at: at, deleted_at: null }
}

function newAppRepayment(at: string, transactionId: string | null, amount = "300") {
  return { ...oldAppRepayment(at, amount), transaction_id: transactionId }
}

/** What an app older than the column validates a pulled repayment row with. */
const OldRepaymentWire = PersonalDebtRepaymentWire.omit({ transaction_id: true })

describe("a debt repayment's deposit and apps that predate it (receta, paso 4)", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function devices() {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    return { phone: syncClient(http, cookie), old: syncClient(http, cookie), web: syncClient(http, cookie) }
  }

  it("migration 0024 adds personal_debt_repayments.transaction_id as a nullable text column", async () => {
    const columns = await admin.db.execute(sql`select data_type, is_nullable from information_schema.columns where table_name = 'personal_debt_repayments' and column_name = 'transaction_id'`)
    expect(columns.rows).toEqual([{ data_type: "text", is_nullable: "YES" }])
  })

  it("stores and serves the deposit link; an old app ignores it", async () => {
    const { phone, old } = await devices()
    await phone.push([event("personalDebtRepayment", newAppRepayment(T0, DEPOSIT), "create")])
    expect((await admin.db.execute(sql`select transaction_id from personal_debt_repayments`)).rows).toEqual([{ transaction_id: DEPOSIT }])
    const pulled = (await old.pull(0)).body.changes.at(-1)!.row
    expect(pulled.transaction_id).toBe(DEPOSIT)
    const parsed = OldRepaymentWire.safeParse(pulled)
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty("transaction_id")
  })

  it("an old app resending the repayment (key absent) keeps the link, in the database and for every other device", async () => {
    const { phone, old, web } = await devices()
    await phone.push([event("personalDebtRepayment", newAppRepayment(T0, DEPOSIT), "create")])

    const resent = await old.push([event("personalDebtRepayment", oldAppRepayment(T1, "250"))])
    expect(resent.body.results[0]).toMatchObject({ status: "applied" })

    expect((await admin.db.execute(sql`select amount, transaction_id from personal_debt_repayments`)).rows).toEqual([{ amount: "250", transaction_id: DEPOSIT }])
    const changes = (await web.pull(0)).body.changes.filter((change) => change.entity === "personalDebtRepayment")
    expect(changes.at(-1)!.row).toMatchObject({ amount: "250", transaction_id: DEPOSIT })
    expect((await web.snapshot("personalDebtRepayment")).body.rows[0]).toMatchObject({ transaction_id: DEPOSIT })
  })

  it("transaction_id null from a newer app clears it", async () => {
    const { phone, web } = await devices()
    await phone.push([event("personalDebtRepayment", newAppRepayment(T0, DEPOSIT), "create")])
    await web.push([event("personalDebtRepayment", newAppRepayment(T2, null))])
    expect((await admin.db.execute(sql`select transaction_id from personal_debt_repayments`)).rows).toEqual([{ transaction_id: null }])
  })
})
