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

  it("rounds converted amounts to cents instead of returning the long tail of the rate", async () => {
    const { http, cookie, mcp } = await connected()
    const at = "2026-11-06T15:00:00.000Z"
    await syncClient(http, cookie).push([
      event("transaction", transactionRow(randomUUID(), at, { amount: "100", currency: "NIO", account_id: ACCOUNT, description: "Pulpería" }), "create"),
    ])
    const { data } = await mcp.tool("get_monthly_summary", { month: "2026-11" })
    // 120.50 + 450 rent + 100 NIO ÷ 36.6243 (2.7304…) = 573.2304… → 573.23
    expect(data).toMatchObject({ expense: "573.23" })
    for (const amount of JSON.stringify(data).match(/"(?:amount|income|expense|net|spent)":"[^"]*"/g) ?? []) {
      expect(amount).toMatch(/"-?\d+(\.\d{1,2})?"$/)
    }
  })

  it("searches movements by text and pages them", async () => {
    const { mcp } = await connected()
    const { data } = await mcp.tool("search_transactions", { text: "colonia", limit: 5 })
    expect(data).toMatchObject({ total_matches: 1, next_cursor: null })
    expect((data.transactions as { description: string; recorded_by: string }[])[0]).toMatchObject({ description: "Supermercado La Colonia", recorded_by: "app" })
  })

  it("reads a movement on the local day: 01:00 UTC on November 1 is October 31 in Managua", async () => {
    const { http, cookie, mcp } = await connected()
    await syncClient(http, cookie).push([
      event("transaction", transactionRow(randomUUID(), "2026-11-01T01:00:00.000Z", { amount: "35", account_id: ACCOUNT, description: "Cena de Halloween" }), "create"),
    ])
    const october = await mcp.tool("search_transactions", { to: "2026-10-31", limit: 10 })
    expect((october.data.transactions as { description: string }[]).map((t) => t.description)).toEqual(["Cena de Halloween"])
    const november = await mcp.tool("search_transactions", { from: "2026-11-01", text: "halloween", limit: 10 })
    expect(november.data).toMatchObject({ total_matches: 0 })
    const summary = await mcp.tool("get_monthly_summary", { month: "2026-10" })
    expect(summary.data.spending_by_category).toContainEqual(expect.objectContaining({ category_id: "groceries", amount: "35" }))
  })

  describe("search_transactions filters", () => {
    const NETFLIX = "66666666-6666-4666-8666-666666666666"
    type Found = { description: string; recurring_rule_id: string | null }

    async function filtered() {
      const connection = await connected()
      const at = "2026-10-01T12:00:00.000Z"
      await syncClient(connection.http, connection.cookie).push([
        event("recurringRule", { ...rentRule(at), id: NETFLIX, name: "Netflix", amount: "15", start_date: "2026-11-10T15:00:00.000Z", next_date: "2026-11-10T15:00:00.000Z", is_subscription: true }, "create"),
        // NIO 3,662.43 at its own 36.6243 is USD 100.
        event("transaction", transactionRow(randomUUID(), "2026-11-07T15:00:00.000Z", { amount: "3662.43", currency: "NIO", description: "Cine" }), "create"),
        event("transaction", transactionRow(randomUUID(), "2026-11-08T15:00:00.000Z", { amount: "40", description: "Flores", tags: ["boda"] }), "create"),
        event("transaction", transactionRow(randomUUID(), "2026-11-09T15:00:00.000Z", { amount: "60", description: "Vestido", tags: ["bodas-2027"] }), "create"),
        event("transaction", transactionRow(randomUUID(), "2026-11-11T15:00:00.000Z", { amount: "80", description: "Hotel", tags: ["boda", "viaje"] }), "create"),
      ])
      const search = async (args: Record<string, unknown>) => {
        const { result, data } = await connection.mcp.tool("search_transactions", { limit: 50, ...args })
        return { result, data, names: ((data?.transactions as Found[] | undefined) ?? []).map((t) => t.description).sort() }
      }
      return search
    }

    it("narrows by a minimum, a maximum or both, inclusive, in the principal currency", async () => {
      const search = await filtered()
      expect((await search({ min_amount: "450" })).names).toEqual(["Alquiler", "Salario"])
      expect((await search({ max_amount: "40" })).names).toEqual(["Flores", "Netflix"])
      const both = await search({ min_amount: "60", max_amount: "120.50" })
      expect(both.names).toEqual(["Cine", "Hotel", "Supermercado La Colonia", "Vestido"])
      expect(both.data.amount_currency).toBe("USD")
    })

    it("compares a NIO movement by its amount in USD at its own rate", async () => {
      const search = await filtered()
      expect((await search({ min_amount: "100", max_amount: "100" })).names).toEqual(["Cine"])
      expect((await search({ min_amount: "100.01", max_amount: "119" })).names).toEqual([])
    })

    it("rejects a minimum above the maximum and empty tags", async () => {
      const search = await filtered()
      const range = await search({ min_amount: "500", max_amount: "100" })
      expect(range.result.isError).toBe(true)
      expect(JSON.parse(range.result.content[0]!.text)).toEqual({ error: "min_amount must not exceed max_amount" })
      const tags = await search({ tags: ["#"] })
      expect(tags.result.isError).toBe(true)
      expect(JSON.parse(tags.result.content[0]!.text)).toEqual({ error: "tags must not be empty" })
    })

    it("matches tags exactly once normalized, and needs all of them", async () => {
      const search = await filtered()
      expect((await search({ tags: ["#Boda"] })).names).toEqual(["Flores", "Hotel"])
      expect((await search({ tags: ["boda", "Viaje"] })).names).toEqual(["Hotel"])
    })

    it("narrows to what a recurring rule recorded, or to subscriptions, and says which rule", async () => {
      const search = await filtered()
      const rent = await search({ recurring_rule_id: RULE })
      expect(rent.names).toEqual(["Alquiler"])
      expect((rent.data.transactions as Found[])[0]!.recurring_rule_id).toBe(RULE)
      expect((await search({ subscriptions_only: true })).names).toEqual(["Netflix"])
      expect((await search({ recurring_rule_id: RULE, subscriptions_only: true })).names).toEqual([])
    })

    it("counts and pages only what the filters keep", async () => {
      const search = await filtered()
      const first = await search({ min_amount: "40", limit: 2 })
      expect(first.data).toMatchObject({ total_matches: 7, next_cursor: 2 })
      const last = await search({ min_amount: "40", limit: 2, cursor: 6 })
      expect(last.data).toMatchObject({ total_matches: 7, next_cursor: null })
      expect((last.data.transactions as Found[]).length).toBe(1)
    })

    it("leaves searches without the new filters as they were", async () => {
      const search = await filtered()
      const plain = await search({})
      expect(plain.data.total_matches).toBe(8)
      expect(plain.data).not.toHaveProperty("amount_currency")
      // Text still finds tags as a substring.
      expect((await search({ text: "boda" })).names).toEqual(["Flores", "Hotel", "Vestido"])
    })
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
