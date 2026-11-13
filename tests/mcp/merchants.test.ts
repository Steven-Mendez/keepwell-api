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
type ListedTool = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
type Merchant = { id: string; name: string; domain: string | null; is_platform: boolean; default_category_id: string | null; movements: number }
type Found = { id: string; description: string; merchant: { id: string; name: string } | null; via: { id: string; name: string } | null }

// Merchants through MCP: the business and platform of a movement, with the domain's own use cases.
describe("MCP merchants", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  const port = 39881
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
    await syncClient(harness.app, cookie).push([
      event("settings", { id: "settings", principal: "USD", second: "NIO", rate: "36.6243", payment_reminder_days_before: 3, has_completed_onboarding: true, created_at: at, updated_at: at, deleted_at: null }, "create"),
    ])
    const { token } = await connectClient(base, cookie, { scope: "read manage offline_access" })
    const call = async (method: string, params: Record<string, unknown> = {}) => (await mcpCall(base, token!.access_token, method, params)).json()
    const tool = async (name: string, args: Record<string, unknown> = {}) => ((await call("tools/call", { name, arguments: args })) as { result: ToolResult }).result
    const data = <T>(result: ToolResult) => result.structuredContent as T
    const ok = async <T>(name: string, args: Record<string, unknown> = {}) => {
      const result = await tool(name, args)
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeFalsy()
      return data<T>(result)
    }
    const account = await ok<{ result: { account_id: string } }>("create_account", { id: randomUUID(), kind: "cash", name: "Billetera", balance: "500", currency: "USD" })
    const merchants = async () => (await ok<{ merchants: Merchant[] }>("list_merchants")).merchants
    const search = async (args: Record<string, unknown> = {}) => (await ok<{ transactions: Found[] }>("search_transactions", args)).transactions
    const row = async (table: string, id: string) => (await admin.db.execute(sql.raw(`select * from ${table} where id = '${id}'`))).rows[0] as Record<string, unknown>
    return { call, tool, ok, accountId: account.result.account_id, merchants, search, row }
  }

  it("offers the merchant tools, the destructive ones marked so", async () => {
    const { call } = await setup()
    const tools = ((await call("tools/list")) as { result: { tools: ListedTool[] } }).result.tools
    const byName = new Map(tools.map((t) => [t.name, t]))
    for (const name of ["list_merchants", "create_merchant", "update_merchant", "merge_merchants", "delete_merchant"]) expect(byName.has(name), name).toBe(true)
    expect(byName.get("list_merchants")!.annotations?.readOnlyHint).toBe(true)
    expect(byName.get("merge_merchants")!.annotations?.destructiveHint).toBe(true)
    expect(byName.get("delete_merchant")!.annotations?.destructiveHint).toBe(true)
  })

  it("creates and edits merchants, and never makes the same one twice", async () => {
    const { ok, merchants, row } = await setup()
    const id = randomUUID()
    const created = await ok<{ result: { merchant_id: string; domain: string } }>("create_merchant", { id, name: "  Uber   Eats ", domain: "https://www.UberEats.com/ni", is_platform: true })
    expect(created.result).toMatchObject({ merchant_id: id, domain: "ubereats.com" })
    expect(await row("merchants", id)).toMatchObject({ name: "Uber Eats", domain: "ubereats.com", is_platform: true, brand_id: null })

    const again = await ok<{ result: { merchant_id: string; already_existed: boolean } }>("create_merchant", { id: randomUUID(), name: "uber eats" })
    expect(again.result).toEqual({ merchant_id: id, name: "Uber Eats", already_existed: true })

    await ok("update_merchant", { merchant_id: id, name: "Uber Eats NI", default_category_id: "restaurants" })
    await ok("update_merchant", { merchant_id: id, domain: null })
    expect(await merchants()).toEqual([{ id, name: "Uber Eats NI", domain: null, is_platform: true, default_category_id: "restaurants", default_category: expect.any(String), movements: 0 }])
  })

  it("links movements by id or by name, shows and filters them in search, and clears a link with null", async () => {
    const { ok, tool, accountId, merchants, search, row } = await setup()
    const uber = randomUUID()
    await ok("create_merchant", { id: uber, name: "Uber Eats", is_platform: true })

    const movement = randomUUID()
    const created = await ok<{ result: { merchant_id: string; via_merchant_id: string } }>("create_transaction", {
      id: movement, kind: "expense", amount: "8.50", currency: "USD", account_id: accountId, description: "Almuerzo", date: "2026-10-02", merchant: "Subway", via_merchant_id: uber,
    })
    const subway = (await merchants()).find((merchant) => merchant.name === "Subway")!
    expect(created.result).toMatchObject({ merchant_id: subway.id, via_merchant_id: uber })
    expect(await row("transactions", movement)).toMatchObject({ merchant_id: subway.id, via_merchant_id: uber })

    // By name again: the same merchant, not a second one.
    await ok("create_transaction", { id: randomUUID(), kind: "expense", amount: "6", currency: "USD", account_id: accountId, description: "Cena", date: "2026-10-03", merchant: "SUBWAY" })
    expect((await merchants()).filter((merchant) => merchant.name === "Subway")).toHaveLength(1)
    expect((await merchants()).find((merchant) => merchant.id === subway.id)!.movements).toBe(2)

    const found = await search({ merchant_id: uber })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: movement, merchant: { id: subway.id, name: "Subway" }, via: { id: uber, name: "Uber Eats" } })
    expect((await search({ text: "uber" })).map((t) => t.id)).toEqual([movement])

    expect((await tool("create_transaction", { id: randomUUID(), kind: "expense", amount: "1", currency: "USD", account_id: accountId, description: "x", date: "2026-10-03", merchant_id: randomUUID() })).isError).toBe(true)

    // Left out keeps; null clears.
    await ok("update_transaction", { transaction_id: movement, description: "Almuerzo grande" })
    expect(await row("transactions", movement)).toMatchObject({ description: "Almuerzo grande", merchant_id: subway.id, via_merchant_id: uber })
    await ok("update_transaction", { transaction_id: movement, via_merchant_id: null })
    expect(await row("transactions", movement)).toMatchObject({ merchant_id: subway.id, via_merchant_id: null })
    expect((await search({ text: "almuerzo" }))[0]).toMatchObject({ merchant: { id: subway.id, name: "Subway" }, via: null })
  })

  it("sets merchants on recurring and categorization rules, and in apply_changes", async () => {
    const { ok, accountId, row } = await setup()
    const netflix = randomUUID()
    const apple = randomUUID()
    const rule = randomUUID()
    const categorization = randomUUID()
    await ok("apply_changes", {
      changes: [
        { tool: "create_merchant", arguments: { id: netflix, name: "Netflix" } },
        { tool: "create_merchant", arguments: { id: apple, name: "Apple", is_platform: true } },
        { tool: "create_recurring_rule", arguments: { id: rule, kind: "expense", amount: "9.99", currency: "USD", account_id: accountId, category_id: "subscriptions", name: "Netflix", frequency: "monthly", start_date: "2026-12-01", merchant_id: netflix, via_merchant_id: apple } },
        { tool: "create_categorization_rule", arguments: { id: categorization, match: "netflix", category_id: "subscriptions", kind: "expense", merchant_id: netflix } },
      ],
    })
    expect(await row("recurring_rules", rule)).toMatchObject({ merchant_id: netflix, via_merchant_id: apple })
    expect(await row("categorization_rules", categorization)).toMatchObject({ merchant_id: netflix })

    await ok("update_recurring_rule", { rule_id: rule, kind: "expense", amount: "12.99", currency: "USD", account_id: accountId, category_id: "subscriptions", name: "Netflix", frequency: "monthly", start_date: "2026-12-01" })
    expect(await row("recurring_rules", rule)).toMatchObject({ amount: "12.99", merchant_id: netflix, via_merchant_id: apple })
    await ok("update_recurring_rule", { rule_id: rule, kind: "expense", amount: "12.99", currency: "USD", account_id: accountId, category_id: "subscriptions", name: "Netflix", frequency: "monthly", start_date: "2026-12-01", via_merchant_id: null })
    expect(await row("recurring_rules", rule)).toMatchObject({ merchant_id: netflix, via_merchant_id: null })

    await ok("update_categorization_rule", { rule_id: categorization, match: "netflix.com", category_id: "subscriptions", kind: "expense" })
    expect(await row("categorization_rules", categorization)).toMatchObject({ match: "netflix.com", merchant_id: netflix })
    await ok("update_categorization_rule", { rule_id: categorization, match: "netflix.com", category_id: "subscriptions", kind: "expense", merchant_id: null })
    expect(await row("categorization_rules", categorization)).toMatchObject({ merchant_id: null })
  })

  it("merges and deletes merchants, relinking what named them, and restore_deleted undoes it", async () => {
    const { ok, accountId, merchants, row } = await setup()
    const subway = randomUUID()
    const duplicate = randomUUID()
    await ok("create_merchant", { id: subway, name: "Subway" })
    await ok("create_merchant", { id: duplicate, name: "Subway Metrocentro", domain: "subway.com" })
    const movement = randomUUID()
    await ok("create_transaction", { id: movement, kind: "expense", amount: "5", currency: "USD", account_id: accountId, description: "Sub", date: "2026-10-02", merchant_id: duplicate })

    const merged = await ok<{ changes: { trash_id: string } }>("merge_merchants", { from_merchant_id: duplicate, into_merchant_id: subway })
    expect(await row("transactions", movement)).toMatchObject({ merchant_id: subway })
    expect(await row("merchants", subway)).toMatchObject({ domain: "subway.com" })
    expect(await row("merchants", duplicate)).toMatchObject({ deleted_at: expect.any(String) })

    const restored = await ok<{ new_ids: Record<string, string> }>("restore_deleted", { trash_id: merged.changes.trash_id })
    const back = restored.new_ids[duplicate]!
    expect(await row("merchants", back)).toMatchObject({ name: "Subway Metrocentro", deleted_at: null })
    expect(await row("transactions", movement)).toMatchObject({ merchant_id: back })
    expect(await row("merchants", subway)).toMatchObject({ domain: null })

    const deleted = await ok<{ changes: { trash_id: string } }>("delete_merchant", { merchant_id: back })
    expect(await row("transactions", movement)).toMatchObject({ merchant_id: null, description: "Sub" })
    expect((await merchants()).map((merchant) => merchant.id)).toEqual([subway])
    expect(deleted.changes.trash_id).toEqual(expect.any(String))
  })
})
