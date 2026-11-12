import { randomUUID } from "node:crypto"

import { serve, type ServerType } from "@hono/node-server"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { adminDatabase, appDatabase } from "../support/database"
import { connectClient, mcpCall } from "../support/oauth"
import { signIn, testAuthApp } from "../support/auth"
import { event, syncClient, wipe } from "../support/sync"

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const UBER_RULE = "22222222-2222-4222-8222-222222222222"
const NETFLIX_RULE = "33333333-3333-4333-8333-333333333333"
const RECURRING = "44444444-4444-4444-8444-444444444444"
const at = "2026-10-01T12:00:00.000Z"
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] }

function ruleRow(id: string, match: string, categoryId: string, sortIndex: number) {
  return { id, match, category_id: categoryId, kind: "expense", tags: [], sort_index: sortIndex, created_at: at, updated_at: at, deleted_at: null }
}

// T26: a new movement without a category, or in Other, takes the person's first matching
// categorization rule on every path the server writes: the manage tools, apply_changes, the pending
// write tool and the recurring occurrences recorded when reading the ledger. Edits never.
describe("categorization rules on every MCP path", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  const port = 39879
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

  async function setup(scope: string, extra: ReturnType<typeof event>[] = []) {
    const { cookie } = await signIn(harness.app, "000001.author")
    const userId = ((await (await harness.app.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await harness.entitlements.grant(userId, { plan: "supporter", source: "manual" })
    await syncClient(harness.app, cookie).push([
      event("settings", { id: "settings", principal: "USD", second: "NIO", rate: "36.6243", payment_reminder_days_before: 3, has_completed_onboarding: true, created_at: at, updated_at: at, deleted_at: null }, "create"),
      event("account", { id: ACCOUNT, name: "Ahorro", bank: null, kind: "deposit", opening_balances: [{ amount: "1000", currency: "USD" }], opening_date: "2026-10-01T06:00:00.000Z", debt_mode: null, limit_amount: null, limit_currency: null, cutoff_day: null, due_day: null, created_at: at, updated_at: at, deleted_at: null }, "create"),
      event("categorizationRule", ruleRow(UBER_RULE, "uber", "transport", 0), "create"),
      ...extra,
    ])
    const { token } = await connectClient(base, cookie, { scope })
    const tool = async (name: string, args: Record<string, unknown> = {}) => ((await (await mcpCall(base, token!.access_token, "tools/call", { name, arguments: args })).json()) as { result: ToolResult }).result
    return { tool }
  }

  const movement = (description: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), kind: "expense", amount: "8", currency: "USD", account_id: ACCOUNT, description, date: "2026-11-05T18:00:00.000Z", ...extra })
  const stored = async (id: string) => ((await admin.db.execute(sql`select category_id from transactions where id = ${id}`)).rows[0] as { category_id: string } | undefined)?.category_id
  const result = (tool: ToolResult) => (tool.structuredContent as { result: Record<string, unknown> }).result

  it("create_transaction without a category takes the rule, and says so; Other when none matches", async () => {
    const { tool } = await setup("read manage offline_access")
    const ruled = movement("UBER *TRIP")
    const saved = await tool("create_transaction", ruled)
    expect(saved.isError, saved.content[0]?.text).toBeFalsy()
    expect(result(saved)).toMatchObject({ category_id: "transport", categorized_by_rule: { id: UBER_RULE, match: "uber" } })
    expect(await stored(ruled.id)).toBe("transport")

    const unmatched = movement("Bakery")
    const other = await tool("create_transaction", unmatched)
    expect(result(other)).toMatchObject({ category_id: "other-expense" })
    expect(result(other)).not.toHaveProperty("categorized_by_rule")

    const chosen = movement("Uber eats", { category_id: "restaurants" })
    expect(result(await tool("create_transaction", chosen))).toMatchObject({ category_id: "restaurants" })
    expect(await stored(chosen.id)).toBe("restaurants")
  })

  it("apply_changes categorizes every new movement", async () => {
    const { tool } = await setup("read manage offline_access")
    const first = movement("Uber home")
    const second = movement("uber to work")
    const applied = await tool("apply_changes", { changes: [first, second].map((args) => ({ tool: "create_transaction", arguments: args })) })
    expect(applied.isError, applied.content[0]?.text).toBeFalsy()
    expect(await stored(first.id)).toBe("transport")
    expect(await stored(second.id)).toBe("transport")
  })

  it("update_transaction never applies the rules again", async () => {
    const { tool } = await setup("read manage offline_access")
    const plain = movement("Bakery", { category_id: "other-expense" })
    await tool("create_transaction", plain)
    expect(await stored(plain.id)).toBe("other-expense")
    const edited = await tool("update_transaction", { transaction_id: plain.id, description: "Uber home" })
    expect(edited.isError, edited.content[0]?.text).toBeFalsy()
    expect(await stored(plain.id)).toBe("other-expense")
  })

  it("the pending create_transaction categorizes the same way", async () => {
    const { tool } = await setup("read write offline_access")
    const pending = movement("Uber airport")
    const saved = await tool("create_transaction", pending)
    expect(saved.isError, saved.content[0]?.text).toBeFalsy()
    expect(saved.structuredContent).toMatchObject({ status: "pending_confirmation", category_id: "transport", categorized_by_rule: { id: UBER_RULE, match: "uber" } })
    expect(await stored(pending.id)).toBe("transport")
  })

  it("a recurring occurrence in Other recorded when reading the ledger takes the matching rule", async () => {
    const start = "2026-10-03T15:00:00.000Z"
    const { tool } = await setup("read manage offline_access", [
      event("categorizationRule", ruleRow(NETFLIX_RULE, "netflix", "subscriptions", 1), "create"),
      event(
        "recurringRule",
        {
          id: RECURRING, name: "Netflix", kind: "expense", category_id: "other-expense", amount: "15", currency: "USD", account_id: ACCOUNT, card_id: null, destination_account_id: null,
          frequency: "monthly", interval: 1, start_date: start, next_date: start, end_date: null,
          is_subscription: true, auto_confirm: true, is_paused: false, note: null, tags: [], created_at: at, updated_at: at, deleted_at: null,
        },
        "create"
      ),
    ])
    expect((await tool("get_financial_context")).isError).toBeFalsy()
    const rows = (await admin.db.execute(sql`select distinct category_id from transactions where recurring_id = ${RECURRING}`)).rows
    expect(rows).toEqual([{ category_id: "subscriptions" }])
  })
})
