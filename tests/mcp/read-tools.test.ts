import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { occurrenceId } from "../../src/core/domain/schema"
import { adminDatabase, appDatabase } from "../support/database"
import { mcpClient } from "../support/mcp"
import { signIn, testAuthApp } from "../support/auth"
import { categoryRow, event, syncClient, transactionRow, wipe } from "../support/sync"

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const RULE = "55555555-5555-4555-8555-555555555555"
const NOW = new Date("2026-11-15T15:00:00.000Z")

function accountRow(at: string) {
  return { id: ACCOUNT, name: "Ahorro", bank: "BAC", kind: "deposit", opening_balances: [{ amount: "1000", currency: "USD" }], opening_date: "2026-10-01T06:00:00.000Z", debt_mode: null, limit_amount: null, limit_currency: null, cutoff_day: null, due_day: null, created_at: at, updated_at: at, deleted_at: null }
}

function settingsRow(at: string) {
  return { id: "settings", principal: "USD", second: "NIO", rate: "36.6243", payment_reminder_days_before: 3, has_completed_onboarding: true, created_at: at, updated_at: at, deleted_at: null }
}

function rentRule(at: string) {
  return {
    id: RULE, name: "Alquiler", kind: "expense", category_id: "housing", amount: "450", currency: "USD", account_id: ACCOUNT, card_id: null, destination_account_id: null,
    frequency: "monthly", interval: 1, start_date: "2026-10-01T15:00:00.000Z", next_date: "2026-11-01T15:00:00.000Z", end_date: null,
    is_subscription: false, auto_confirm: true, is_paused: false, note: null, tags: [], created_at: at, updated_at: at, deleted_at: null,
  }
}

describe("MCP read tools", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function connected() {
    const { app: http, entitlements } = testAuthApp(app.db, {}, { now: () => NOW })
    const { cookie } = await signIn(http, "000001.author")
    const userId = ((await (await http.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await entitlements.grant(userId, { plan: "supporter", source: "manual" })
    const at = "2026-10-01T12:00:00.000Z"
    await syncClient(http, cookie).push([
      event("settings", settingsRow(at), "create"),
      event("account", accountRow(at), "create"),
      event("category", { ...categoryRow("groceries", "Groceries", at), budget_amount: "400", budget_currency: "USD" }, "create"),
      event("category", categoryRow("housing", "Housing", at), "create"),
      event("transaction", transactionRow(randomUUID(), "2026-11-03T15:00:00.000Z", { amount: "120.50", account_id: ACCOUNT, description: "Supermercado La Colonia" }), "create"),
      event("transaction", transactionRow(randomUUID(), "2026-11-05T15:00:00.000Z", { amount: "2000", kind: "income", category_id: "salary", account_id: ACCOUNT, description: "Salario" }), "create"),
      event("recurringRule", rentRule(at), "create"),
    ])
    return { http, cookie, userId, mcp: mcpClient(http, { cookie }) }
  }

  it("speaks MCP: initialize and list the read-only tools", async () => {
    const { mcp } = await connected()
    const init = await mcp.initialize()
    expect(init.status).toBe(200)
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("keepwell")
    const list = await mcp.call("tools/list")
    const tools = (list.body as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result.tools
    expect(tools.map((t) => t.name).sort()).toEqual(["get_financial_context", "get_monthly_summary", "get_net_worth", "get_trends", "get_upcoming_payments", "list_accounts", "list_categories", "list_categorization_rules", "list_loans", "list_personal_debts", "list_recurring_rules", "list_savings_goals", "search_transactions"])
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true)
  })

  it("answers how much was spent this month, including the rent due on the 1st that no app recorded", async () => {
    const { mcp } = await connected()
    const { data } = await mcp.tool("get_monthly_summary", { month: "2026-11" })
    expect(data).toMatchObject({ month: "2026-11", currency: "USD", income: "2000", expense: "570.5", net: "1429.5" })
    expect(data.spending_by_category).toEqual([
      { category_id: "housing", category: "Housing", amount: "450", share: "0.7888" },
      { category_id: "groceries", category: "Groceries", amount: "120.5", share: "0.2112" },
    ])
    expect(data.budgets).toMatchObject([{ category_id: "groceries", budget: "400", spent: "120.5" }])
  })

  it("records the due occurrence once, with the shared id, however many times it is read", async () => {
    const { mcp } = await connected()
    await mcp.tool("get_financial_context")
    await mcp.tool("get_net_worth")
    // next_date was Nov 1, so the November occurrence (index 1 from the October start) is the one due.
    const id = occurrenceId({ id: RULE, startDate: "2026-10-01T15:00:00.000Z", frequency: "monthly", interval: 1 }, 1)
    const rows = (await admin.db.execute(sql`select id, source from transactions where recurring_id = ${RULE}`)).rows
    expect(rows).toEqual([{ id, source: "app" }])
    const rule = (await admin.db.execute<{ next_date: string }>(sql`select next_date from recurring_rules where id = ${RULE}`)).rows[0]
    expect(rule!.next_date).toBe("2026-12-01T15:00:00.000Z")
  })

  it("computes balances and net worth with the shared domain", async () => {
    const { mcp } = await connected()
    const { data } = await mcp.tool("get_net_worth")
    // 1000 opening + 2000 income − 120.50 groceries − 450 November rent = 2429.50
    expect(data).toMatchObject({ currency: "USD", net_worth: { amount: "2429.5", currency: "USD" } })
    expect((data.net_worth_in_second_currency as { currency: string }).currency).toBe("NIO")
  })

  it("searches movements by text and pages them", async () => {
    const { mcp } = await connected()
    const { data } = await mcp.tool("search_transactions", { text: "colonia", limit: 5 })
    expect(data).toMatchObject({ total_matches: 1, next_cursor: null })
    expect((data.transactions as { description: string; recorded_by: string }[])[0]).toMatchObject({ description: "Supermercado La Colonia", recorded_by: "app" })
  })

  it("lists upcoming payments", async () => {
    const { mcp } = await connected()
    const { data } = await mcp.tool("get_upcoming_payments", { days: 30 })
    expect((data.payments as { name: string; date: string }[]).map((p) => [p.name, p.date])).toEqual([["Alquiler", "2026-12-01"]])
  })

  it("answers 401 with WWW-Authenticate without credentials, and 403 needs_plan without the coffee", async () => {
    const { app: http } = testAuthApp(app.db)
    const anonymous = await mcpClient(http, {}).initialize()
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("www-authenticate")).toContain('resource_metadata="http://localhost:3001/.well-known/oauth-protected-resource"')
    const { cookie } = await signIn(http, "000002.second")
    const free = await mcpClient(http, { cookie }).initialize()
    expect(free.status).toBe(403)
    expect(String(free.body)).toContain("needs_plan")
  })
})
