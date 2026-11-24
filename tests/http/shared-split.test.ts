import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { signIn, testAuthApp } from "../support/auth"
import { adminDatabase, appDatabase } from "../support/database"
import { event, syncClient, transactionRow, wipe } from "../support/sync"

const T0 = "2026-11-22T18:00:00.000Z"
const T1 = "2026-11-22T19:00:00.000Z"
const DINNER = "44444444-4444-4444-8444-444444444444"
const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-"

function dinner(at: string, extra: Record<string, unknown> = {}): ReturnType<typeof transactionRow> & { share_token?: string | null } {
  return transactionRow(DINNER, at, { description: "Los Taki Pollos", amount: "1156.25", currency: "NIO", category_id: "restaurants", note: "Mesa M12", share_token: TOKEN, ...extra })
}

function share(id: string, person: string, amount: string, settledAt: string | null = null) {
  return { id, person, direction: "theyOweMe", amount, currency: "NIO", date: T0, note: "Los Taki Pollos", settled_at: settledAt, transaction_id: DINNER, due_date: null, created_at: T0, updated_at: T0, deleted_at: null }
}

describe("a shared split's public page", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function shared(sub = "000001.author") {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, sub)
    const phone = syncClient(http, cookie)
    await phone.push([
      event("transaction", dinner(T0), "create"),
      event("personalDebt", share("55555555-5555-4555-8555-555555555551", "Mario", "247.37"), "create"),
      event("personalDebt", share("55555555-5555-4555-8555-555555555552", "Lía", "511.88", T0), "create"),
      event("personalDebtRepayment", { id: "66666666-6666-4666-8666-666666666661", debt_id: "55555555-5555-4555-8555-555555555552", amount: "511.88", date: T0, transaction_id: null, created_at: T0, updated_at: T0, deleted_at: null }, "create"),
    ])
    return { http, phone }
  }

  it("shows each share and who paid, without a session and without the rest of the ledger", async () => {
    const { http } = await shared()
    const res = await http.request(`/shared/${TOKEN}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      description: "Los Taki Pollos",
      date: T0,
      amount: "1156.25",
      currency: "NIO",
      owner_share: "397",
      shares: [
        { person: "Mario", amount: "247.37", currency: "NIO", repaid: "0", paid: false },
        { person: "Lía", amount: "511.88", currency: "NIO", repaid: "511.88", paid: true },
      ],
    })
  })

  it("answers the same 404 for a malformed, unknown or revoked link", async () => {
    const { http, phone } = await shared()
    for (const token of ["short", "ZZZZZZZZZZZZZZZZZZZZZZ"]) expect((await http.request(`/shared/${token}`)).status).toBe(404)
    await phone.push([event("transaction", dinner(T1, { share_token: null }))])
    const res = await http.request(`/shared/${TOKEN}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: "shared_split_not_found" } })
  })

  it("stops working once the expense is deleted", async () => {
    const { http, phone } = await shared()
    await phone.push([event("transaction", { ...dinner(T1), deleted_at: T1 })])
    expect((await http.request(`/shared/${TOKEN}`)).status).toBe(404)
  })

  it("keeps the link when an app older than the column edits the expense", async () => {
    const { http, phone } = await shared()
    const { share_token: _, ...older } = dinner(T1, { note: "Mesa M13" })
    await phone.push([event("transaction", older)])
    expect((await http.request(`/shared/${TOKEN}`)).status).toBe(200)
  })
})
