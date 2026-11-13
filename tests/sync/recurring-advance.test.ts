import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { occurrenceId } from "../../src/core/domain/schema"
import { adminDatabase, appDatabase } from "../support/database"
import { mcpClient } from "../support/mcp"
import { signIn, testAuthApp } from "../support/auth"
import { categoryRow, event, syncClient, wipe } from "../support/sync"

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const RULE = "55555555-5555-4555-8555-555555555555"
const SUNDAY = "2026-11-01T15:00:00.000Z"
const MONDAY = "2026-11-02T15:00:00.000Z"
const TUESDAY = new Date("2026-11-03T18:00:00.000Z")
const DUE = "2026-11-03T15:00:00.000Z"
const ADVANCED = "2026-12-03T15:00:00.000Z"

function rule(at: string, extra: Record<string, unknown> = {}) {
  return {
    id: RULE, name: "Gimnasio", kind: "expense", category_id: "health", amount: "30", currency: "USD", account_id: ACCOUNT, card_id: null, destination_account_id: null,
    frequency: "monthly", interval: 1, start_date: "2026-10-03T15:00:00.000Z", next_date: DUE, end_date: null,
    is_subscription: false, auto_confirm: true, is_paused: false, note: null, tags: [], created_at: SUNDAY, updated_at: at, deleted_at: null, ...extra,
  }
}

describe("the server advancing a recurring rule", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  it("keeps an edit made offline before the advance and sent after it", async () => {
    let now = new Date(SUNDAY)
    const { app: http, entitlements } = testAuthApp(app.db, {}, { now: () => now })
    const { cookie } = await signIn(http, "000001.author")
    const userId = ((await (await http.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await entitlements.grant(userId, { plan: "supporter", source: "manual" })
    const phone = syncClient(http, cookie)
    const mcp = mcpClient(http, { cookie })
    await phone.push([
      event("settings", { id: "settings", principal: "USD", second: "NIO", rate: "36.6243", payment_reminder_days_before: 3, has_completed_onboarding: true, created_at: SUNDAY, updated_at: SUNDAY, deleted_at: null }, "create"),
      event("account", { id: ACCOUNT, name: "Ahorro", bank: "BAC", kind: "deposit", opening_balances: [{ amount: "1000", currency: "USD" }], opening_date: "2026-10-01T06:00:00.000Z", debt_mode: null, limit_amount: null, limit_currency: null, cutoff_day: null, due_day: null, created_at: SUNDAY, updated_at: SUNDAY, deleted_at: null }, "create"),
      event("category", categoryRow("health", "Health", SUNDAY), "create"),
      event("recurringRule", rule(SUNDAY), "create"),
    ])
    const { body: start } = await phone.pull(0)

    // Monday, offline: the phone raises the amount. Tuesday the server reads the ledger and records
    // the occurrence due that day, advancing the rule.
    const edit = event("recurringRule", rule(MONDAY, { amount: "35" }))
    now = TUESDAY
    await mcp.tool("get_financial_context")
    const advance = await phone.pull(start.next_cursor)
    const advanced = advance.body.changes.find((change) => change.entity === "recurringRule")
    // The advance reaches the devices with the stamp the rule already had.
    expect(advanced?.row).toMatchObject({ next_date: ADVANCED, amount: "30", updated_at: SUNDAY })

    // The phone comes back online and sends Monday's edit: it wins over the advance.
    expect((await phone.push([edit])).body.results[0]).toMatchObject({ status: "applied" })

    // The edit carried the old next date; the next read advances the rule again, and only the rule.
    await mcp.tool("get_financial_context")
    await mcp.tool("get_net_worth")
    const stored = (await admin.db.execute<{ amount: string; next_date: string }>(sql`select amount, next_date from recurring_rules where id = ${RULE}`)).rows
    expect(stored).toEqual([{ amount: "35", next_date: ADVANCED }])
    const id = occurrenceId({ id: RULE, startDate: "2026-10-03T15:00:00.000Z", frequency: "monthly", interval: 1 }, 1)
    expect((await admin.db.execute(sql`select id from transactions where recurring_id = ${RULE}`)).rows).toEqual([{ id }])

    // Every device ends with the edit and the advance.
    const { body: caughtUp } = await phone.pull(0)
    const last = caughtUp.changes.filter((change) => change.entity === "recurringRule").at(-1)
    expect(last?.row).toMatchObject({ amount: "35", next_date: ADVANCED, updated_at: MONDAY })
  })
})
