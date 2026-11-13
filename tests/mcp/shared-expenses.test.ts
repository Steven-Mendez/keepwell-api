import { randomUUID } from "node:crypto"

import { serve, type ServerType } from "@hono/node-server"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { adminDatabase, appDatabase } from "../support/database"
import { connectClient, mcpCall } from "../support/oauth"
import { signIn, testAuthApp } from "../support/auth"
import { event, syncClient, wipe } from "../support/sync"

const at = "2026-10-01T12:00:00.000Z"
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] }
type Repayment = { id: string; amount: string; transaction_id: string | null }
type Debt = { id: string; person: string; amount: { amount: string; currency: string }; transaction_id: string | null; settled_at: string | null; repayments: Repayment[] }

// Shared expenses through the MCP: split_transaction, repayments deposited into an account, and the
// summaries counting only the person's share, as the apps do (keepwell-web f6f10ad).
describe("MCP shared expenses and debt repayments", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  const port = 39883
  const base = `http://localhost:${port}`
  let server: ServerType
  let harness: ReturnType<typeof testAuthApp>

  beforeAll(() => {
    harness = testAuthApp(app.db, {}, { baseURL: base })
    server = serve({ fetch: harness.app.fetch, port })
  })
  afterAll(async () => {
    server.close()
    await Promise.all([app.close(), admin.close()])
  })
  beforeEach(async () => {
    await wipe(admin.db)
    for (const table of ["oauth_consents", "oauth_refresh_tokens", "oauth_access_tokens", "oauth_clients", "oauth_client_resources"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  async function setup() {
    const { cookie } = await signIn(harness.app, "000001.author")
    const userId = ((await (await harness.app.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await harness.entitlements.grant(userId, { plan: "supporter", source: "manual" })
    const phone = syncClient(harness.app, cookie)
    await phone.push([
      event("settings", { id: "settings", principal: "USD", second: "NIO", rate: "36.6243", payment_reminder_days_before: 3, has_completed_onboarding: true, created_at: at, updated_at: at, deleted_at: null }, "create"),
    ])
    const { token } = await connectClient(base, cookie, { scope: "read manage offline_access" })
    const call = async (method: string, params: Record<string, unknown> = {}) => (await mcpCall(base, token!.access_token, method, params)).json()
    const tool = async (name: string, args: Record<string, unknown> = {}) => ((await call("tools/call", { name, arguments: args })) as { result: ToolResult }).result
    const data = <T>(result: ToolResult) => result.structuredContent as T
    const accountId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Efectivo", balance: "1000", currency: "USD" })).result.account_id
    const debts = async () => data<{ debts: Debt[] }>(await tool("list_personal_debts")).debts
    return { phone, tool, data, accountId, debts }
  }

  const now = () => new Date().toISOString()

  it("split_transaction splits equally, or by the amounts given, and the summary counts only the person's share", async () => {
    const { tool, data, accountId, debts } = await setup()
    const dinner = randomUUID()
    await tool("create_transaction", { id: dinner, kind: "expense", amount: "90", currency: "USD", account_id: accountId, category_id: "restaurants", description: "Cena", date: now() })

    const split = await tool("split_transaction", { transaction_id: dinner, shares: [{ person: "Ana" }, { person: "Luis" }] })
    expect(split.isError).toBeFalsy()
    const created = data<{ result: { debts: { debt_id: string; person: string; amount: { amount: string; currency: string } }[] } }>(split).result.debts
    expect(created.map(({ person, amount }) => ({ person, amount }))).toEqual([
      { person: "Ana", amount: { amount: "30", currency: "USD" } },
      { person: "Luis", amount: { amount: "30", currency: "USD" } },
    ])
    const listed = await debts()
    expect(listed.map((debt) => debt.id).sort()).toEqual(created.map((debt) => debt.debt_id).sort())
    for (const debt of listed) expect(debt).toMatchObject({ transaction_id: dinner, direction: "theyOweMe" })
    expect(await admin.db.execute(sql`select count(*)::int as n from personal_debts where transaction_id = ${dinner}`)).toMatchObject({ rows: [{ n: 2 }] })

    const summary = data<{ expense: string; spending_by_category: { category_id: string; amount: string }[] }>(await tool("get_monthly_summary"))
    expect(summary.expense).toBe("30")
    expect(summary.spending_by_category).toEqual([expect.objectContaining({ category_id: "restaurants", amount: "30" })])
    expect(data<{ this_month: { expense: string } }>(await tool("get_financial_context")).this_month.expense).toBe("30")
    expect(data<{ months: { expense: string }[] }>(await tool("get_trends", { months: 1 })).months.at(-1)!.expense).toBe("30")

    const found = data<{ transactions: { id: string; split: boolean; your_share: { amount: string; currency: string } | null }[] }>(await tool("search_transactions", { kind: "expense" })).transactions
    expect(found.find((movement) => movement.id === dinner)).toMatchObject({ split: true, your_share: { amount: "30", currency: "USD" } })

    // By amounts: all of them, or none.
    const taxi = randomUUID()
    await tool("create_transaction", { id: taxi, kind: "expense", amount: "20", currency: "USD", account_id: accountId, category_id: "transport", description: "Taxi", date: now() })
    expect((await tool("split_transaction", { transaction_id: taxi, shares: [{ person: "Ana", amount: "5" }, { person: "Luis" }] })).isError).toBe(true)
    expect((await tool("split_transaction", { transaction_id: taxi, shares: [{ person: "Ana", amount: "25" }] })).isError).toBe(true)
    expect((await tool("split_transaction", { transaction_id: taxi, shares: [{ person: "Ana", amount: "15" }] })).isError).toBeFalsy()
    expect(data<{ expense: string }>(await tool("get_monthly_summary")).expense).toBe("35")
    // Only expenses split.
    const salary = randomUUID()
    await tool("create_transaction", { id: salary, kind: "income", amount: "500", currency: "USD", account_id: accountId, category_id: "salary", description: "Salario", date: now() })
    expect((await tool("split_transaction", { transaction_id: salary, shares: [{ person: "Ana" }] })).isError).toBe(true)
  })

  it("a repayment deposited into an account records a linked income that isn't counted as income, and deleting it takes both back", async () => {
    const { tool, data, accountId, debts } = await setup()
    const debtId = data<{ result: { debt_id: string } }>(await tool("create_personal_debt", { id: randomUUID(), person: "Ana", direction: "theyOweMe", amount: "50", currency: "USD", date: now(), note: "Cena" })).result.debt_id

    const repaid = await tool("update_personal_debt_status", { debt_id: debtId, action: "repay", amount: "50", deposit_account_id: accountId })
    expect(repaid.isError).toBeFalsy()
    const result = data<{ result: { repayment_id: string; transaction_id: string; settled: boolean } }>(repaid).result
    expect(result.settled).toBe(true)
    expect(result.transaction_id).toEqual(expect.any(String))

    // Both rows were written in the same call, linked.
    expect((await admin.db.execute(sql`select transaction_id from personal_debt_repayments where id = ${result.repayment_id}`)).rows).toEqual([{ transaction_id: result.transaction_id }])
    expect((await admin.db.execute(sql`select kind, amount, account_id, category_id, description, status from transactions where id = ${result.transaction_id}`)).rows).toEqual([
      { kind: "income", amount: "50", account_id: accountId, category_id: "refunds", description: "Ana · Cena", status: "confirmed" },
    ])
    const [debt] = await debts()
    expect(debt!.repayments).toEqual([expect.objectContaining({ id: result.repayment_id, amount: "50", transaction_id: result.transaction_id })])
    expect(data<{ income: string }>(await tool("get_monthly_summary")).income).toBe("0")
    expect(data<{ by_account: { total: { amount: string } }[] }>(await tool("get_net_worth")).by_account[0]!.total.amount).toBe("1050")

    // Delete: the repayment and its movement go, the debt opens again; restore_deleted brings them back linked.
    const deleted = await tool("delete_debt_repayment", { debt_id: debtId, repayment_id: result.repayment_id })
    expect(deleted.isError).toBeFalsy()
    expect(data<{ result: { settled: boolean } }>(deleted).result.settled).toBe(false)
    expect((await admin.db.execute(sql`select deleted_at is not null as gone from transactions where id = ${result.transaction_id}`)).rows).toEqual([{ gone: true }])
    expect((await debts())[0]).toMatchObject({ settled_at: null, repayments: [] })

    const trashId = data<{ changes: { trash_id: string } }>(deleted).changes.trash_id
    expect((await tool("restore_deleted", { trash_id: trashId })).isError).toBeFalsy()
    const [restored] = await debts()
    expect(restored!.repayments).toHaveLength(1)
    const link = restored!.repayments[0]!.transaction_id!
    expect((await admin.db.execute(sql`select kind, deleted_at from transactions where id = ${link}`)).rows).toEqual([{ kind: "income", deleted_at: null }])
  })

  it("refuses a deposit on a debt the person owes, and saves nothing", async () => {
    const { tool, data, accountId, debts } = await setup()
    const debtId = data<{ result: { debt_id: string } }>(await tool("create_personal_debt", { id: randomUUID(), person: "Luis", direction: "iOwe", amount: "40", currency: "USD", date: now() })).result.debt_id
    const refused = await tool("update_personal_debt_status", { debt_id: debtId, action: "repay", amount: "10", deposit_account_id: accountId })
    expect(refused.isError).toBe(true)
    expect((await debts())[0]!.repayments).toEqual([])
    expect(await admin.db.execute(sql`select count(*)::int as n from transactions`)).toMatchObject({ rows: [{ n: 0 }] })
    // A deposit into an account that isn't the person's, inside a batch: nothing at all is written.
    const batch = await tool("apply_changes", {
      changes: [
        { tool: "update_personal_debt_status", arguments: { debt_id: debtId, action: "repay", amount: "10" } },
        { tool: "update_personal_debt_status", arguments: { debt_id: debtId, action: "repay", amount: "10", deposit_account_id: randomUUID() } },
      ],
    })
    expect(batch.isError).toBe(true)
    expect((await debts())[0]!.repayments).toEqual([])
  })

  it("an MCP edit of a debt keeps the deposit link an app set on its repayment", async () => {
    const { phone, tool, data, accountId } = await setup()
    const debtId = data<{ result: { debt_id: string } }>(await tool("create_personal_debt", { id: randomUUID(), person: "Ana", direction: "theyOweMe", amount: "50", currency: "USD", date: "2026-11-01T12:00:00.000Z" })).result.debt_id
    const deposit = randomUUID()
    await tool("create_transaction", { id: deposit, kind: "income", amount: "20", currency: "USD", account_id: accountId, category_id: "refunds", description: "Ana", date: now() })
    const repaymentId = randomUUID()
    const stamp = new Date().toISOString()
    await phone.push([event("personalDebtRepayment", { id: repaymentId, debt_id: debtId, amount: "20", date: "2026-11-02T12:00:00.000Z", transaction_id: deposit, created_at: stamp, updated_at: stamp, deleted_at: null }, "create")])

    expect((await tool("update_personal_debt", { debt_id: debtId, person: "Ana María", direction: "theyOweMe", amount: "60", currency: "USD", date: "2026-11-01T12:00:00.000Z" })).isError).toBeFalsy()
    expect((await admin.db.execute(sql`select person from personal_debts where id = ${debtId}`)).rows).toEqual([{ person: "Ana María" }])
    expect((await admin.db.execute(sql`select transaction_id from personal_debt_repayments where id = ${repaymentId}`)).rows).toEqual([{ transaction_id: deposit }])
    // A further repayment through the MCP rewrites the debt's repayments; the app's link stays.
    expect((await tool("update_personal_debt_status", { debt_id: debtId, action: "repay", amount: "5" })).isError).toBeFalsy()
    expect((await admin.db.execute(sql`select id, transaction_id from personal_debt_repayments order by date`)).rows).toEqual([
      { id: repaymentId, transaction_id: deposit },
      { id: expect.any(String), transaction_id: null },
    ])
  })
})
