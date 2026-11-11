import { randomUUID } from "node:crypto"

import { serve, type ServerType } from "@hono/node-server"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { MCP_WRITES_PER_HOUR } from "../../src/core/use-cases/create-pending"
import { adminDatabase, appDatabase } from "../support/database"
import { connectClient, mcpCall } from "../support/oauth"
import { signIn, testAuthApp } from "../support/auth"
import { event, syncClient, transactionRow, wipe } from "../support/sync"

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const at = "2026-10-01T12:00:00.000Z"

describe("MCP write tools", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  const port = 39874
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

  async function setup(scope: string) {
    const { cookie } = await signIn(harness.app, "000001.author")
    const userId = ((await (await harness.app.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await harness.entitlements.grant(userId, { plan: "supporter", source: "manual" })
    await syncClient(harness.app, cookie).push([
      event("settings", { id: "settings", principal: "USD", second: "NIO", rate: "36.6243", payment_reminder_days_before: 3, has_completed_onboarding: true, created_at: at, updated_at: at, deleted_at: null }, "create"),
      event("account", { id: ACCOUNT, name: "Ahorro", bank: null, kind: "deposit", opening_balances: [{ amount: "1000", currency: "USD" }], opening_date: "2026-10-01T06:00:00.000Z", debt_mode: null, limit_amount: null, limit_currency: null, cutoff_day: null, due_day: null, created_at: at, updated_at: at, deleted_at: null }, "create"),
      event("category", { id: "restaurants", name: "Restaurants", kind: "expense", icon: null, color: null, is_renamed: false, sort_index: 0, budget_amount: null, budget_currency: null, created_at: at, updated_at: at, deleted_at: null }, "create"),
    ])
    const { token, clientId } = await connectClient(base, cookie, { scope })
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpCall(base, token!.access_token, "tools/call", { name, arguments: args })
      return ((await res.json()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] } }).result
    }
    return { cookie, userId, token: token!.access_token, clientId, tool }
  }

  const lunch = (id = randomUUID()) => ({ id, kind: "expense", amount: "18.50", currency: "USD", account_id: ACCOUNT, category_id: "restaurants", description: "Almuerzo", date: "2026-11-05T18:00:00.000Z" })

  it("offers no write tool to a read-only token", async () => {
    const { token } = await setup("read offline_access")
    const list = ((await (await mcpCall(base, token, "tools/list")).json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    expect(list).not.toContain("create_transaction")
    expect(list).not.toContain("create_recurring_rule")
  })

  it("shows both write tools with a title and the pending card view (ADR 0009)", async () => {
    const { token } = await setup("read write offline_access")
    const tools = ((await (await mcpCall(base, token, "tools/list")).json()) as { result: { tools: { name: string; title?: string; _meta?: { ui?: { resourceUri?: string } } }[] } }).result.tools
    for (const name of ["create_transaction", "create_recurring_rule"]) {
      const tool = tools.find((t) => t.name === name)
      expect(tool?.title, name).toBeTruthy()
      expect(tool?._meta?.ui?.resourceUri, name).toBe("ui://keepwell/views")
    }
  })

  it("records a pending movement made by mcp that balances ignore until confirmed", async () => {
    const { tool } = await setup("read write offline_access")
    const id = randomUUID()
    const result = await tool("create_transaction", lunch(id))
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ id, status: "pending_confirmation" })
    const rows = (await admin.db.execute(sql`select status, source from transactions where id = ${id}`)).rows
    expect(rows).toEqual([{ status: "planned", source: "mcp" }])
    const worth = await tool("get_net_worth", {})
    expect(worth.structuredContent).toMatchObject({ net_worth: { amount: "1000" } })
  })

  it("never records a retried call twice", async () => {
    const { tool } = await setup("read write offline_access")
    const call = lunch()
    await tool("create_transaction", call)
    await tool("create_transaction", call)
    expect((await admin.db.execute(sql`select count(*)::int as n from change_log where entity = 'transaction' and entity_id = ${call.id}`)).rows).toEqual([{ n: 1 }])
  })

  it("validates like a movement typed by hand, and can't touch the person's own movements", async () => {
    const { tool, cookie } = await setup("read write offline_access")
    const unknownAccount = await tool("create_transaction", { ...lunch(), account_id: randomUUID() })
    expect(unknownAccount.isError).toBe(true)
    expect(unknownAccount.content[0]!.text).toContain("invalid")
    const wrongCurrency = await tool("create_transaction", { ...lunch(), currency: "EUR" })
    expect(wrongCurrency.isError).toBe(true)

    const own = randomUUID()
    await syncClient(harness.app, cookie).push([event("transaction", transactionRow(own, at, { account_id: ACCOUNT, category_id: "restaurants" }), "create")])
    const overwrite = await tool("create_transaction", lunch(own))
    expect(overwrite.isError).toBe(true)
    expect(overwrite.content[0]!.text).toContain("not_editable")
  })

  it(`stops after ${MCP_WRITES_PER_HOUR} writes in an hour`, async () => {
    const { tool } = await setup("read write offline_access")
    for (let i = 0; i < MCP_WRITES_PER_HOUR; i++) expect((await tool("create_transaction", lunch())).isError).toBeFalsy()
    const over = await tool("create_transaction", lunch())
    expect(over.isError).toBe(true)
    expect(over.content[0]!.text).toContain("rate_limited")
  })

  it("sets up a recurring payment that stays paused until confirmed", async () => {
    const { tool } = await setup("read write offline_access")
    const id = randomUUID()
    const result = await tool("create_recurring_rule", { id, kind: "expense", amount: "12.99", currency: "USD", account_id: ACCOUNT, category_id: "restaurants", name: "Streaming", frequency: "monthly", start_date: "2026-12-01T12:00:00.000Z", is_subscription: true })
    expect(result.structuredContent).toMatchObject({ id, status: "pending_confirmation" })
    expect((await admin.db.execute(sql`select is_paused, source from recurring_rules where id = ${id}`)).rows).toEqual([{ is_paused: true, source: "mcp" }])
  })

  it("keeps source = mcp when the person confirms the movement in an app", async () => {
    const { tool, cookie } = await setup("read write offline_access")
    const id = randomUUID()
    await tool("create_transaction", lunch(id))
    const pulled = (await syncClient(harness.app, cookie).pull(0)).body.changes.find((change) => change.entity_id === id)!
    expect(pulled.row).toMatchObject({ status: "planned", source: "mcp" })
    const confirmed = { ...pulled.row, status: "confirmed", updated_at: new Date().toISOString() }
    delete (confirmed as { source?: string }).source
    await syncClient(harness.app, cookie).push([event("transaction", confirmed as never)])
    expect((await admin.db.execute(sql`select status, source from transactions where id = ${id}`)).rows).toEqual([{ status: "confirmed", source: "mcp" }])
  })
})
