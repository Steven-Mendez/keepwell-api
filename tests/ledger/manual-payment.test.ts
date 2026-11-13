import { describe, expect, it } from "vitest"

import type { LedgerRows } from "../../src/core/ledger/wire-to-domain"
import type { LedgerReader } from "../../src/core/ports/ledger-reader"
import type { ApplySyncBatch } from "../../src/core/use-cases/apply-sync-batch"
import { ReadLedger } from "../../src/core/use-cases/read-ledger"
import { categoryRow, transactionRow } from "../support/sync"

// T29: the server records due occurrences when it reads the ledger; one the person already paid by
// hand (same account, amount within 7.5 %, up to two days before) is not recorded again.

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const RULE = "55555555-5555-4555-8555-555555555555"
const MANUAL = "66666666-6666-4666-8666-666666666666"
const AT = "2026-10-01T15:00:00.000Z"
const DUE = "2026-11-03T15:00:00.000Z"
const ADVANCED = "2026-12-03T15:00:00.000Z"
const TUESDAY = new Date("2026-11-03T18:00:00.000Z")

const settings = { id: "settings", principal: "USD", second: "NIO", rate: "36.6243", payment_reminder_days_before: 3, has_completed_onboarding: true, time_zone: "America/Managua", created_at: AT, updated_at: AT, deleted_at: null }
const account = { id: ACCOUNT, name: "Ahorro", bank: "BAC", kind: "deposit", opening_balances: [{ amount: "1000", currency: "USD" }], opening_date: "2026-10-01T06:00:00.000Z", debt_mode: null, limit_amount: null, limit_currency: null, cutoff_day: null, due_day: null, created_at: AT, updated_at: AT, deleted_at: null }
const rule = {
  id: RULE, name: "Alquiler", kind: "expense", category_id: "housing", amount: "500", currency: "USD", account_id: ACCOUNT, card_id: null, destination_account_id: null,
  frequency: "monthly", interval: 1, start_date: "2026-10-03T15:00:00.000Z", next_date: DUE, end_date: null,
  is_subscription: false, auto_confirm: true, is_paused: false, note: null, tags: [], created_at: AT, updated_at: AT, deleted_at: null,
}

function rows(manualPayment: Record<string, unknown> | undefined): LedgerRows {
  return {
    account: [account], card: [], category: [categoryRow("housing", "Housing", AT)],
    transaction: manualPayment ? [transactionRow(MANUAL, "2026-11-01T16:00:00.000Z", { description: "Alquiler", category_id: "housing", amount: "500", ...manualPayment })] : [],
    recurringRule: [rule], savingsGoal: [], loan: [], loanPayment: [], personalDebt: [], personalDebtRepayment: [], categorizationRule: [],
    settings: [settings], notificationState: [],
  } as unknown as LedgerRows
}

async function read(ledgerRows: LedgerRows) {
  const pushed: { entity: string; operation: string; entity_id: string; payload: Record<string, unknown> }[] = []
  const reader: LedgerReader = { load: async () => ledgerRows, latestDeviceTimeZone: async () => undefined }
  const writer = { execute: async (input: { events: typeof pushed }) => void pushed.push(...input.events) } as unknown as ApplySyncBatch
  await new ReadLedger(reader, writer, "America/Managua", () => TUESDAY).load("user")
  return pushed
}

describe("the server recording an occurrence paid by hand (T29)", () => {
  it("records no movement for it and still advances the rule", async () => {
    const events = await read(rows({}))
    expect(events.filter((event) => event.entity === "transaction")).toEqual([])
    expect(events).toEqual([expect.objectContaining({ entity: "recurringRule", operation: "update", entity_id: RULE, payload: expect.objectContaining({ next_date: ADVANCED }) })])
  })

  it("records it when the movement doesn't match: another amount, or three days before", async () => {
    for (const different of [{ amount: "540" }, { date: "2026-10-31T16:00:00.000Z" }]) {
      const events = await read(rows(different))
      expect(events.filter((event) => event.entity === "transaction").map((event) => event.operation)).toEqual(["create"])
    }
    expect((await read(rows(undefined))).filter((event) => event.entity === "transaction")).toHaveLength(1)
  })
})
