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

// T28: a bank statement's lines into one account, without duplicating what is already recorded and
// without touching what the person wrote.
describe("MCP import_transactions", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  const port = 39878
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

  async function setup(scope = "read manage offline_access") {
    const { cookie } = await signIn(harness.app, "000001.author")
    const userId = ((await (await harness.app.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await harness.entitlements.grant(userId, { plan: "supporter", source: "manual" })
    await syncClient(harness.app, cookie).push([
      event("settings", { id: "settings", principal: "USD", second: "NIO", rate: "36.6243", payment_reminder_days_before: 3, has_completed_onboarding: true, created_at: at, updated_at: at, deleted_at: null }, "create"),
    ])
    const { token } = await connectClient(base, cookie, { scope })
    const call = async (method: string, params: Record<string, unknown> = {}) => (await mcpCall(base, token!.access_token, method, params)).json()
    const tool = async (name: string, args: Record<string, unknown> = {}) => ((await call("tools/call", { name, arguments: args })) as { result: ToolResult }).result
    const data = <T>(result: ToolResult) => result.structuredContent as T
    return { cookie, userId, call, tool, data }
  }

  const count = async (query: ReturnType<typeof sql>) => Number(((await admin.db.execute(query)).rows[0] as { n: string | number }).n)

  async function ledger(tool: Awaited<ReturnType<typeof setup>>["tool"], data: Awaited<ReturnType<typeof setup>>["data"]) {
    const accountId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Billetera", balance: "500", currency: "USD" })).result.account_id
    return accountId
  }

  const statement = (accountId: string, dryRun?: boolean) => ({
    account_id: accountId,
    ...(dryRun === undefined ? {} : { dry_run: dryRun }),
    lines: [
      { day: "2026-10-04", direction: "out", amount: "4.25", currency: "USD", description: "CAFE LA CASITA" },
      { day: "2026-10-04", direction: "out", amount: "4.25", currency: "USD", description: "CAFE LA CASITA" },
      { day: "2026-10-06", direction: "out", amount: "37.90", currency: "USD", description: "POS SUPERMERCADO 0042", imported_id: "FIT-0042" },
      { day: "2026-10-07", direction: "in", amount: "120", currency: "USD", description: "TRANSFERENCIA RECIBIDA", category_id: "other-income", note: "Reembolso" },
    ],
  })

  it("is a manage tool, not offered to write tokens nor inside apply_changes", async () => {
    const managed = await setup()
    const names = (((await managed.call("tools/list")) as { result: { tools: ListedTool[] } }).result.tools).map((t) => t.name)
    expect(names).toContain("import_transactions")
    const refused = await managed.tool("apply_changes", { changes: [{ tool: "import_transactions", arguments: statement(randomUUID()) }] })
    expect(refused.isError).toBe(true)

    await wipe(admin.db)
    const writer = await setup("read write offline_access")
    const writeNames = (((await writer.call("tools/list")) as { result: { tools: ListedTool[] } }).result.tools).map((t) => t.name)
    expect(writeNames).not.toContain("import_transactions")
  })

  it("a dry run, the default, writes nothing to the change log", async () => {
    const { tool, data } = await setup()
    const accountId = await ledger(tool, data)
    const before = await count(sql`select count(*) as n from change_log`)
    const preview = await tool("import_transactions", statement(accountId))
    expect(preview.isError).toBeFalsy()
    expect(data(preview)).toMatchObject({ ok: true, result: { dry_run: true, counts: { new: 4, existing: 0, skipped: 0 } }, changes: { created: 0, updated: 0 } })
    expect(await count(sql`select count(*) as n from change_log`)).toBe(before)
    expect(await count(sql`select count(*) as n from transactions where account_id = ${accountId}`)).toBe(0)
  })

  it("applying the same statement twice leaves the same rows", async () => {
    const { tool, data } = await setup()
    const accountId = await ledger(tool, data)
    const first = await tool("import_transactions", statement(accountId, false))
    expect(data(first)).toMatchObject({ ok: true, result: { dry_run: false, counts: { new: 4, existing: 0, skipped: 0 } }, changes: { created: 4 } })
    const rows = await count(sql`select count(*) as n from transactions where account_id = ${accountId}`)
    expect(rows).toBe(4)
    expect(await count(sql`select count(*) as n from transactions where account_id = ${accountId} and source = 'mcp' and status = 'confirmed' and imported_id is not null`)).toBe(4)
    const [income] = (await admin.db.execute(sql`select category_id, note, kind from transactions where account_id = ${accountId} and imported_id is not null and kind = 'income'`)).rows
    expect(income).toEqual({ category_id: "other-income", note: "Reembolso", kind: "income" })

    const again = await tool("import_transactions", statement(accountId, false))
    expect(data(again)).toMatchObject({ ok: true, result: { counts: { new: 0, existing: 4, skipped: 0 } }, changes: { created: 0, updated: 0 } })
    expect(await count(sql`select count(*) as n from transactions where account_id = ${accountId}`)).toBe(rows)
  })

  it("an existing movement keeps its description and category and gains the imported id; a transfer's leg is skipped; a draft stays pending", async () => {
    const { tool, data } = await setup()
    const accountId = await ledger(tool, data)
    const savingsId = await ledger(tool, data)
    const typed = randomUUID()
    const created = (result: { isError?: boolean; content: { text: string }[] }) => expect(result.isError, result.content[0]?.text).toBeFalsy()
    created(await tool("create_transaction", { id: typed, kind: "expense", amount: "37.90", currency: "USD", account_id: accountId, category_id: "groceries", description: "Súper de la semana", note: "con Ana", date: "2026-10-05" }))
    const draft = randomUUID()
    created(await tool("create_transaction", { id: draft, kind: "expense", amount: "4.25", currency: "USD", account_id: accountId, category_id: "restaurants", description: "Café", date: "2026-10-04", status: "planned" }))
    const transfer = randomUUID()
    created(await tool("create_transaction", { id: transfer, kind: "transfer", amount: "120", currency: "USD", account_id: savingsId, destination_account_id: accountId, description: "A la billetera", date: "2026-10-07" }))

    const preview = data<{ result: { lines: Record<string, unknown>[] } }>(await tool("import_transactions", statement(accountId)))
    expect(preview.result.lines).toEqual([
      { line: 0, result: "existing", by: "amount_date", transaction_id: draft, movement: { description: "Café", date: "2026-10-04", status: "planned" } },
      { line: 1, result: "new", imported_id: expect.stringMatching(/^kw1:/) },
      { line: 2, result: "existing", by: "amount_date", transaction_id: typed, movement: { description: "Súper de la semana", date: "2026-10-05", status: "confirmed" } },
      { line: 3, result: "skipped", reason: "transfer_leg", transaction_id: transfer, movement: { description: "A la billetera", date: "2026-10-07", status: "confirmed" } },
    ])

    const applied = await tool("import_transactions", statement(accountId, false))
    expect(data(applied)).toMatchObject({ ok: true, result: { counts: { new: 1, existing: 2, skipped: 1 } }, changes: { created: 1, updated: 2 } })
    expect((await admin.db.execute(sql`select description, category_id, note, amount, date, status, imported_id from transactions where id = ${typed}`)).rows[0]).toEqual({
      description: "Súper de la semana",
      category_id: "groceries",
      note: "con Ana",
      amount: "37.9",
      date: "2026-10-05T18:00:00.000Z",
      status: "confirmed",
      imported_id: "FIT-0042",
    })
    expect((await admin.db.execute(sql`select status, imported_id from transactions where id = ${draft}`)).rows[0]).toEqual({ status: "planned", imported_id: expect.stringMatching(/^kw1:/) })
    expect((await admin.db.execute(sql`select imported_id from transactions where id = ${transfer}`)).rows[0]).toEqual({ imported_id: null })
  })

  it("refuses the whole statement when a line can't be saved, and saves nothing", async () => {
    const { tool, data } = await setup()
    const accountId = await ledger(tool, data)
    const good = statement(accountId, false)
    // An income line in an expense category can't be saved.
    const bad = { ...good, lines: good.lines.map((line, index): Record<string, unknown> => (index === 3 ? { ...line, category_id: "groceries" } : line)) }
    const refused = await tool("import_transactions", bad)
    expect(refused.isError).toBe(true)
    expect(await count(sql`select count(*) as n from transactions where account_id = ${accountId}`)).toBe(0)
    expect((await tool("import_transactions", { ...statement(accountId), lines: [{ ...statement(accountId).lines[0]!, day: "2026-02-30" }] })).isError).toBe(true)
  })
})
