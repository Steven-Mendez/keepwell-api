import { describe, expect, it } from "vitest"

import { toDomain, type LedgerRows } from "../../src/core/ledger/wire-to-domain"

const at = "2026-11-12T00:00:00.000Z"

function rule(id: string, sortIndex: number): LedgerRows["categorizationRule"][number] {
  return { id, match: id.slice(0, 4), category_id: "food", kind: "expense", tags: [], sort_index: sortIndex, created_at: at, updated_at: at, deleted_at: null }
}

function rows(categorizationRule: LedgerRows["categorizationRule"]): LedgerRows {
  return {
    account: [],
    card: [],
    category: [],
    transaction: [],
    recurringRule: [],
    savingsGoal: [],
    loan: [],
    loanPayment: [],
    personalDebt: [],
    personalDebtRepayment: [],
    categorizationRule,
    settings: [],
    notificationState: [],
    merchant: [],
  }
}

describe("categorization rule order", () => {
  it("breaks a sort_index tie by id, whatever order the rows arrive in", () => {
    const first = "aaaaaaaa-0000-4000-8000-000000000000"
    const tiedLow = "bbbbbbbb-0000-4000-8000-000000000000"
    const tiedHigh = "cccccccc-0000-4000-8000-000000000000"
    const expected = [first, tiedLow, tiedHigh]
    const orders = [
      [rule(tiedHigh, 1), rule(first, 0), rule(tiedLow, 1)],
      [rule(tiedLow, 1), rule(tiedHigh, 1), rule(first, 0)],
    ]
    for (const order of orders) {
      expect(toDomain(rows(order)).categorizationRules.map((r) => r.id)).toEqual(expected)
    }
  })
})
