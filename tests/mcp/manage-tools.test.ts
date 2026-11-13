import { randomUUID } from "node:crypto"

import { serve, type ServerType } from "@hono/node-server"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { adminDatabase, appDatabase } from "../support/database"
import { connectClient, mcpCall } from "../support/oauth"
import { signIn, testAuthApp } from "../support/auth"
import { event, syncClient, wipe } from "../support/sync"

const at = "2026-10-01T12:00:00.000Z"
/** Movements count toward a balance from the account's opening on, which is when the tool creates it. */
const today = () => new Date().toISOString()
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] }
type ListedTool = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }

// The manage tools (ADR 0011): what the apps' screens do, applied directly through the same domain
// use cases, deletes undoable for 30 days.
describe("MCP manage tools", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  const port = 39876
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

  it("offers the app's actions only to a manage token, deletes marked destructive", async () => {
    const managed = await setup()
    const tools = ((await managed.call("tools/list")) as { result: { tools: ListedTool[] } }).result.tools
    const names = tools.map((t) => t.name)
    for (const name of ["create_account", "create_credit_card", "delete_account", "create_category", "update_transaction", "confirm_transaction", "create_loan", "update_settings", "restore_deleted"]) expect(names).toContain(name)
    for (const t of tools.filter((t) => t.name.startsWith("delete_"))) expect(t.annotations?.destructiveHint, t.name).toBe(true)

    await wipe(admin.db)
    const writer = await setup("read write offline_access")
    const writeNames = (((await writer.call("tools/list")) as { result: { tools: ListedTool[] } }).result.tools).map((t) => t.name)
    expect(writeNames).toContain("create_transaction")
    expect(writeNames).not.toContain("create_account")
    expect(writeNames).not.toContain("delete_transaction")
  })

  it("creates an account with its cards and records a confirmed movement, as the app would", async () => {
    const { tool, data } = await setup()
    const accountCall = { id: randomUUID(), kind: "deposit", name: "Ahorro", bank: "BAC", balance: "1000", currency: "USD", debit_card: { last_four: "4321", network: "visa" } }
    const created = await tool("create_account", accountCall)
    expect(created.isError).toBeFalsy()
    const accountId = data<{ result: { account_id: string } }>(created).result.account_id
    expect(await count(sql`select count(*) as n from ledger_accounts where id = ${accountId}`)).toBe(1)
    // The debit card and the transfer channel, like the app's "Debit card".
    expect(await count(sql`select count(*) as n from cards where account_id = ${accountId}`)).toBe(2)
    // A retry creates nothing twice.
    expect((await tool("create_account", accountCall)).isError).toBeFalsy()
    expect(await count(sql`select count(*) as n from ledger_accounts`)).toBe(1)

    const movementId = randomUUID()
    const movement = await tool("create_transaction", { id: movementId, kind: "expense", amount: "18.50", currency: "USD", account_id: accountId, category_id: "restaurants", description: "Almuerzo", date: today() })
    expect(data(movement)).toMatchObject({ ok: true, result: { id: movementId, status: "saved" } })
    expect((await admin.db.execute(sql`select status, source from transactions where id = ${movementId}`)).rows).toEqual([{ status: "confirmed", source: "mcp" }])
    expect(data(await tool("get_net_worth"))).toMatchObject({ net_worth: { amount: "981.5" } })
  })

  it("reads a date without a time as that day in the person's home zone, which update_settings changes (T21)", async () => {
    const { tool, data } = await setup()
    const accountId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Efectivo", balance: "0", currency: "USD" })).result.account_id
    const stored = async (id: string) => ((await admin.db.execute(sql`select date from transactions where id = ${id}`)).rows[0] as { date: string }).date
    // No zone in the settings and no device: the deployment's default (America/Managua, UTC-6).
    const managua = randomUUID()
    await tool("create_transaction", { id: managua, kind: "expense", amount: "1", currency: "USD", account_id: accountId, category_id: "groceries", description: "Uno", date: "2026-11-12" })
    expect(await stored(managua)).toBe("2026-11-12T18:00:00.000Z")
    expect(data(await tool("get_financial_context"))).toMatchObject({ time_zone: "America/Managua" })

    expect(data(await tool("update_settings", { time_zone: "Asia/Tokyo" }))).toMatchObject({ ok: true, result: { time_zone: "Asia/Tokyo" } })
    expect((await admin.db.execute(sql`select time_zone from settings`)).rows).toEqual([{ time_zone: "Asia/Tokyo" }])
    const tokyo = randomUUID()
    await tool("create_transaction", { id: tokyo, kind: "expense", amount: "1", currency: "USD", account_id: accountId, category_id: "groceries", description: "Dos", date: "2026-11-12" })
    expect(await stored(tokyo)).toBe("2026-11-12T03:00:00.000Z")
    expect(data(await tool("get_financial_context"))).toMatchObject({ time_zone: "Asia/Tokyo" })
    expect((await tool("update_settings", { time_zone: "Mars/Olympus" })).isError).toBe(true)
  })

  it("deletes an account with its cascade, and restore_deleted brings it all back under new ids", async () => {
    const { tool, data } = await setup()
    const accountId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Efectivo", balance: "200", currency: "USD" })).result.account_id
    await tool("create_transaction", { id: randomUUID(), kind: "expense", amount: "20", currency: "USD", account_id: accountId, category_id: "groceries", description: "Súper", date: today() })

    const deleted = await tool("delete_account", { account_id: accountId })
    const changes = data<{ changes: { deleted: number; trash_id: string } }>(deleted).changes
    expect(changes.deleted).toBe(2)
    expect(await count(sql`select count(*) as n from transactions where deleted_at is null`)).toBe(0)

    const listed = data<{ deleted: { trash_id: string; what: string }[] }>(await tool("list_deleted"))
    expect(listed.deleted).toEqual([expect.objectContaining({ trash_id: changes.trash_id, what: "Account Efectivo" })])

    const restored = await tool("restore_deleted", { trash_id: changes.trash_id })
    expect(restored.isError).toBeFalsy()
    const newAccount = data<{ new_ids: Record<string, string> }>(restored).new_ids[accountId]!
    expect(newAccount).not.toBe(accountId)
    expect((await admin.db.execute(sql`select account_id, description from transactions where deleted_at is null`)).rows).toEqual([{ account_id: newAccount, description: "Súper" }])
    expect(data(await tool("get_net_worth"))).toMatchObject({ net_worth: { amount: "180" } })
    // Once.
    expect((await tool("restore_deleted", { trash_id: changes.trash_id })).isError).toBe(true)
  })

  it("deletes a category the way the app does: its movements move to Other, and back on restore", async () => {
    const { tool, data } = await setup()
    const accountId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Efectivo", balance: "200", currency: "USD" })).result.account_id
    const categoryId = data<{ result: { category_id: string } }>(await tool("create_category", { id: randomUUID(), name: "Gimnasio", kind: "expense", monthly_budget: "40" })).result.category_id
    const movementId = randomUUID()
    await tool("create_transaction", { id: movementId, kind: "expense", amount: "35", currency: "USD", account_id: accountId, category_id: categoryId, description: "Mensualidad", date: "2026-11-05T18:00:00.000Z" })

    const deleted = await tool("delete_category", { category_id: categoryId })
    expect(deleted.isError).toBeFalsy()
    const other = (await admin.db.execute(sql`select category_id from transactions where id = ${movementId}`)).rows[0] as { category_id: string }
    expect(other.category_id).not.toBe(categoryId)

    const restored = await tool("restore_deleted", { trash_id: data<{ changes: { trash_id: string } }>(deleted).changes.trash_id })
    const newCategory = data<{ new_ids: Record<string, string> }>(restored).new_ids[categoryId]!
    expect((await admin.db.execute(sql`select category_id from transactions where id = ${movementId}`)).rows).toEqual([{ category_id: newCategory }])
    expect((await admin.db.execute(sql`select name, budget_amount from categories where id = ${newCategory}`)).rows).toEqual([{ name: "Gimnasio", budget_amount: "40" }])
  })

  it("edits, confirms and keeps the app's rules for currencies", async () => {
    const { tool, data, cookie } = await setup()
    const accountId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Efectivo", balance: "100", currency: "USD" })).result.account_id
    const planned = randomUUID()
    await tool("create_transaction", { id: planned, kind: "income", amount: "50", currency: "USD", account_id: accountId, category_id: "salary", description: "Pago", date: "2026-11-05T18:00:00.000Z", status: "planned" })
    expect((await tool("confirm_transaction", { transaction_id: planned })).isError).toBeFalsy()
    await tool("update_transaction", { transaction_id: planned, amount: "60", description: "Pago extra" })
    expect((await admin.db.execute(sql`select status, amount, description from transactions where id = ${planned}`)).rows).toEqual([{ status: "confirmed", amount: "60", description: "Pago extra" }])

    const principal = await tool("update_settings", { principal_currency: "EUR" })
    expect(principal.isError).toBe(true)
    expect(principal.content[0]!.text).toContain("principal currency")
    expect((await tool("update_settings", { rate: "37" })).isError).toBeFalsy()
    expect((await admin.db.execute(sql`select rate from settings`)).rows).toEqual([{ rate: "37" }])

    // The apps see it as any other change.
    const pulled = (await syncClient(harness.app, cookie).pull(0)).body.changes.map((change) => change.entity)
    expect(pulled).toEqual(expect.arrayContaining(["account", "transaction", "settings"]))
  })

  it("runs loans, debts, goals and rules through the same domain checks", async () => {
    const { tool, data } = await setup()
    const accountId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Efectivo", balance: "1000", currency: "USD" })).result.account_id
    const loanId = data<{ result: { loan_id: string } }>(await tool("create_loan", { id: randomUUID(), name: "Moto", borrowed_amount: "1200", currency: "USD", installment_amount: "100", installment_count: 12, frequency: "monthly", first_due_date: "2026-11-15T12:00:00.000Z" })).result.loan_id
    const paid = await tool("pay_loan_installment", { loan_id: loanId, account_id: accountId, category_id: "loan-payments", date: "2026-11-15T12:00:00.000Z" })
    expect(paid.isError, paid.content[0]?.text).toBeFalsy()
    expect(await count(sql`select count(*) as n from loan_payments where loan_id = ${loanId} and deleted_at is null`)).toBe(1)

    const debtId = data<{ result: { debt_id: string } }>(await tool("create_personal_debt", { id: randomUUID(), person: "Ana", direction: "theyOweMe", amount: "50", currency: "USD", date: "2026-11-01T12:00:00.000Z" })).result.debt_id
    expect((await tool("update_personal_debt_status", { debt_id: debtId, action: "repay", amount: "80" })).isError).toBe(true)
    expect((await tool("update_personal_debt_status", { debt_id: debtId, action: "repay", amount: "20" })).isError).toBeFalsy()

    const goalId = data<{ result: { goal_id: string } }>(await tool("create_savings_goal", { id: randomUUID(), name: "Viaje", target_amount: "500", currency: "USD" })).result.goal_id
    expect(data(await tool("move_savings_goal_money", { goal_id: goalId, direction: "add", amount: "75" }))).toMatchObject({ result: { saved: "75" } })

    const rule = await tool("create_categorization_rule", { id: randomUUID(), match: "uber", category_id: "transport", kind: "expense" })
    expect(rule.isError).toBeFalsy()
    expect(data<{ rules: unknown[] }>(await tool("list_categorization_rules")).rules).toHaveLength(1)
  })

  it("gives a personal debt a due date, keeps it when an update leaves it out and removes it with null", async () => {
    const { tool, data } = await setup()
    type Listed = { debts: { id: string; due_date: string | null; due_status: string | null; days_left?: number }[] }
    const listed = async (id: string) => data<Listed>(await tool("list_personal_debts")).debts.find((debt) => debt.id === id)
    const fields = { person: "Ana", direction: "theyOweMe", amount: "12", currency: "USD", date: "2026-09-01" }
    const debtId = data<{ result: { debt_id: string } }>(await tool("create_personal_debt", { id: randomUUID(), ...fields, due_date: "2099-12-15" })).result.debt_id
    const created = await listed(debtId)
    expect(created).toMatchObject({ due_date: "2099-12-15", due_status: "upcoming" })
    expect(created?.days_left).toBeGreaterThan(0)

    expect((await tool("update_personal_debt", { debt_id: debtId, ...fields, note: "Dinner" })).isError).toBeFalsy()
    expect(await listed(debtId)).toMatchObject({ due_date: "2099-12-15", due_status: "upcoming" })

    const before = await tool("update_personal_debt", { debt_id: debtId, ...fields, due_date: "2026-08-31" })
    expect(before.isError).toBe(true)
    expect(await listed(debtId)).toMatchObject({ due_date: "2099-12-15" })

    expect((await tool("update_personal_debt", { debt_id: debtId, ...fields, due_date: null })).isError).toBeFalsy()
    expect(await listed(debtId)).toMatchObject({ due_date: null, due_status: null })
    expect((await admin.db.execute(sql`select due_date from personal_debts where id = ${debtId}`)).rows).toEqual([{ due_date: null }])
  })

  it("applies a batch in one call: an account and its movements, all or nothing, never twice", async () => {
    const { tool, data } = await setup()
    const accountId = randomUUID()
    const batch = {
      lang: "es",
      changes: [
        { tool: "create_account", arguments: { id: accountId, kind: "cash", name: "Efectivo", balance: "2000", currency: "USD" } },
        ...[["Súper", "150"], ["Gasolina", "40"], ["Farmacia", "12.50"]].map(([description, amount]) => ({
          tool: "create_transaction",
          arguments: { id: randomUUID(), kind: "expense", amount, currency: "USD", account_id: accountId, category_id: "groceries", description, date: today() },
        })),
      ],
    }
    const applied = await tool("apply_changes", batch)
    expect(applied.isError, applied.content[0]?.text).toBeFalsy()
    expect(data<{ results: { tool: string }[] }>(applied).results.map((r) => r.tool)).toEqual(["create_account", "create_transaction", "create_transaction", "create_transaction"])
    expect(await count(sql`select count(*) as n from ledger_accounts where id = ${accountId}`)).toBe(1)
    expect(await count(sql`select count(*) as n from transactions where account_id = ${accountId}`)).toBe(3)
    expect(data(await tool("get_net_worth"))).toMatchObject({ net_worth: { amount: "1797.5" } })

    // The same batch again creates nothing twice.
    expect((await tool("apply_changes", batch)).isError).toBeFalsy()
    expect(await count(sql`select count(*) as n from transactions where account_id = ${accountId}`)).toBe(3)

    // One bad step: nothing at all is saved.
    const broken = await tool("apply_changes", {
      changes: [
        { tool: "create_category", arguments: { id: randomUUID(), name: "Mascotas", kind: "expense" } },
        { tool: "create_transaction", arguments: { id: randomUUID(), kind: "expense", amount: "10", currency: "USD", account_id: randomUUID(), description: "Nada", date: today() } },
      ],
    })
    expect(broken.isError).toBe(true)
    expect(broken.content[0]!.text).toContain("changes[1]")
    expect(await count(sql`select count(*) as n from categories where name = 'Mascotas'`)).toBe(0)

    // Deletes are not batchable: each asks on its own.
    expect((await tool("apply_changes", { changes: [{ tool: "delete_account", arguments: { account_id: accountId } }] })).isError).toBe(true)
  })

  it("closes an account keeping its history, moving what is left, and reopens it", async () => {
    const { tool, data } = await setup()
    const account = (name: string, balance: string) => tool("create_account", { id: randomUUID(), kind: "cash", name, balance, currency: "USD" })
    const oldId = data<{ result: { account_id: string } }>(await account("Old wallet", "200")).result.account_id
    const newId = data<{ result: { account_id: string } }>(await account("New wallet", "0")).result.account_id
    const emptyId = data<{ result: { account_id: string } }>(await account("Empty", "0")).result.account_id
    await tool("create_transaction", { id: randomUUID(), kind: "expense", amount: "20", currency: "USD", account_id: oldId, category_id: "groceries", description: "Súper", date: today() })

    const refused = await tool("close_account", { account_id: oldId })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toContain("accountNotEmpty")

    const closed = await tool("close_account", { account_id: oldId, transfer_to_account_id: newId })
    expect(closed.isError).toBeFalsy()
    expect(data(closed)).toMatchObject({ ok: true, result: { account_id: oldId, transfers: [{ amount: { amount: "180", currency: "USD" }, from_account_id: oldId, to_account_id: newId }] } })
    expect((await tool("close_account", { account_id: emptyId })).isError).toBeFalsy()
    // History stays: the expense is still there and the net worth didn't move.
    expect(await count(sql`select count(*) as n from transactions where deleted_at is null and account_id = ${oldId}`)).toBe(2)
    expect(data(await tool("get_net_worth"))).toMatchObject({ net_worth: { amount: "180" } })

    const listed = data<{ accounts: { id: string; closed_at: string | null; balances: { amount: string }[] }[] }>(await tool("list_accounts")).accounts
    expect(listed.find((entry) => entry.id === oldId)).toMatchObject({ closed_at: expect.any(String), balances: [{ amount: "0" }] })
    expect(listed.find((entry) => entry.id === newId)?.closed_at).toBeNull()
    const context = data<{ accounts: { id: string }[] }>(await tool("get_financial_context"))
    expect(context.accounts.map((entry) => entry.id)).toEqual([newId])

    const movement = await tool("create_transaction", { id: randomUUID(), kind: "expense", amount: "5", currency: "USD", account_id: oldId, category_id: "groceries", description: "Café", date: today() })
    expect(movement.isError).toBe(true)
    expect(JSON.parse(movement.content[0]!.text)).toMatchObject({ error: "invalid", message: `Account ${oldId} is closed; reopen it first.` })

    expect(data(await tool("reopen_account", { account_id: oldId }))).toMatchObject({ ok: true, result: { account_id: oldId, closed_at: null } })
    expect((await admin.db.execute(sql`select closed_at from ledger_accounts where id = ${oldId}`)).rows).toEqual([{ closed_at: null }])
    expect((await tool("create_transaction", { id: randomUUID(), kind: "expense", amount: "5", currency: "USD", account_id: oldId, category_id: "groceries", description: "Café", date: today() })).isError).toBeFalsy()
  })

  it("records, shows, edits and clears what the bank actually charged (actual_debited)", async () => {
    const { tool, data } = await setup()
    const accountId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Efectivo", balance: "1000", currency: "USD" })).result.account_id
    const stored = async (id: string) => ((await admin.db.execute(sql`select amount, actual_debited_principal from transactions where id = ${id}`)).rows[0] as { amount: string; actual_debited_principal: string | null })
    const nio = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), kind: "expense", amount: "3690", currency: "NIO", account_id: accountId, category_id: "groceries", description: "Compra", date: today(), ...extra })

    // A movement in the second currency, charged 100 USD by the bank: balances count the charge.
    const call = nio({ actual_debited: "100" })
    const created = await tool("create_transaction", call)
    expect(created.isError, created.content[0]?.text).toBeFalsy()
    expect(data(created)).toMatchObject({ result: { amount: { amount: "3690", currency: "NIO" }, actual_debited: { amount: "100", currency: "USD" } } })
    expect((await stored(call.id)).actual_debited_principal).toBe("100")
    expect(data(await tool("get_net_worth"))).toMatchObject({ net_worth: { amount: "900" } })

    // Refused on a movement already in the principal currency, and when it isn't positive.
    const same = await tool("create_transaction", nio({ currency: "USD", amount: "10", actual_debited: "10" }))
    expect(same.isError).toBe(true)
    expect(same.content[0]!.text).toContain("actual_debited")
    expect(same.content[0]!.text).toContain("invalid")
    const zero = await tool("create_transaction", nio({ actual_debited: "0" }))
    expect(zero.isError).toBe(true)
    expect(zero.content[0]!.text).toContain("greater than zero")
    expect(await count(sql`select count(*) as n from transactions`)).toBe(1)

    // search_transactions shows it next to the amount; null when there is none.
    const plain = nio()
    await tool("create_transaction", plain)
    type Found = { transactions: { id: string; actual_debited: { amount: string; currency: string } | null }[] }
    const found = data<Found>(await tool("search_transactions", { account_id: accountId })).transactions
    expect(found.find((t) => t.id === call.id)!.actual_debited).toEqual({ amount: "100", currency: "USD" })
    expect(found.find((t) => t.id === plain.id)!.actual_debited).toBeNull()

    // Left out, an edit keeps it; a new amount clears it unless given again; null clears it.
    expect((await tool("update_transaction", { transaction_id: call.id, description: "Compra grande" })).isError).toBeFalsy()
    expect((await stored(call.id)).actual_debited_principal).toBe("100")
    expect((await tool("update_transaction", { transaction_id: call.id, amount: "3690.00" })).isError).toBeFalsy()
    expect((await stored(call.id)).actual_debited_principal).toBe("100")
    expect((await tool("update_transaction", { transaction_id: call.id, amount: "3700" })).isError).toBeFalsy()
    expect(await stored(call.id)).toEqual({ amount: "3700", actual_debited_principal: null })
    expect((await tool("update_transaction", { transaction_id: call.id, amount: "3800", actual_debited: "102.50" })).isError).toBeFalsy()
    expect(await stored(call.id)).toEqual({ amount: "3800", actual_debited_principal: "102.5" })
    expect((await tool("update_transaction", { transaction_id: call.id, actual_debited: null })).isError).toBeFalsy()
    expect((await stored(call.id)).actual_debited_principal).toBeNull()
    expect((await tool("update_transaction", { transaction_id: call.id, actual_debited: "101" })).isError).toBeFalsy()
    // Moving it to another account drops it too, unless given again.
    const otherId = data<{ result: { account_id: string } }>(await tool("create_account", { id: randomUUID(), kind: "cash", name: "Billetera", balance: "0", currency: "USD" })).result.account_id
    expect((await tool("update_transaction", { transaction_id: call.id, account_id: otherId })).isError).toBeFalsy()
    expect((await stored(call.id)).actual_debited_principal).toBeNull()
    expect((await tool("update_transaction", { transaction_id: call.id, account_id: accountId, actual_debited: "101" })).isError).toBeFalsy()
    expect((await stored(call.id)).actual_debited_principal).toBe("101")
    // A change to the principal currency drops it; asking to keep one there is refused.
    const toUsd = await tool("update_transaction", { transaction_id: call.id, currency: "USD", amount: "101", actual_debited: "101" })
    expect(toUsd.isError).toBe(true)
    expect(toUsd.content[0]!.text).toContain("actual_debited")
    expect((await tool("update_transaction", { transaction_id: call.id, currency: "USD", amount: "101" })).isError).toBeFalsy()
    expect(await stored(call.id)).toEqual({ amount: "101", actual_debited_principal: null })

    // apply_changes takes it too.
    const batched = nio({ actual_debited: "50" })
    const applied = await tool("apply_changes", { changes: [{ tool: "create_transaction", arguments: batched }] })
    expect(applied.isError, applied.content[0]?.text).toBeFalsy()
    expect((await stored(batched.id)).actual_debited_principal).toBe("50")
  })
})
