import { describe, expect, it } from "vitest"

import fixtures from "../../src/core/domain/fixtures/upcoming.json"
import type { UpcomingFixtures } from "../../src/core/domain/fixtures"
import { getUpcomingPayments } from "../../src/core/mcp/read-tools"
import { upcomingFixtureLedger } from "../support/upcoming"

// get_upcoming_payments reads the domain's upcomingPayments: for the shared ledger it returns the
// same entries, in the same order, as Home on the web and on iOS.
const data = fixtures as UpcomingFixtures
const entry = data.cases[0]!
const debtsEntry = data.cases.find((candidate) => candidate.ledger.personalDebts !== undefined)!

describe("get_upcoming_payments", () => {
  it("returns the shared fixture's ids and statuses, overdue first", () => {
    for (const shared of data.cases) {
      for (const window of shared.windows) {
        const { payments } = getUpcomingPayments(upcomingFixtureLedger(shared), window.days, new Date(shared.now))
        expect(payments.map(({ id, status }) => ({ id, status }))).toEqual(window.expected)
      }
    }
  })

  it("lists personal debts with a due date for what's left, and nothing from a closed account", () => {
    const { payments } = getUpcomingPayments(upcomingFixtureLedger(debtsEntry), 7, new Date(debtsEntry.now))
    expect(payments.filter((payment) => payment.type === "personal_debt")).toEqual([
      expect.objectContaining({ name: "Ana", direction: "theyOweMe", status: "overdue", days_from_today: -7, date: "2026-11-05", amount: { amount: "60", currency: "USD" } }),
      expect.objectContaining({ name: "Luis", direction: "iOwe", status: "today", days_from_today: 0, amount: { amount: "50", currency: "USD" } }),
      expect.objectContaining({ name: "Marta", direction: "theyOweMe", status: "upcoming", days_from_today: 1, amount: { amount: "900", currency: "NIO" } }),
    ])
    expect(payments.some((payment) => payment.type === "card_due")).toBe(false)
    expect(payments.filter((payment) => payment.type === "recurring").map((payment) => payment.name)).toEqual(["Rent"])
  })

  it("describes each kind with plain fields and its own currency", () => {
    const { from, payments } = getUpcomingPayments(upcomingFixtureLedger(entry), 7, new Date(entry.now))
    expect(from).toBe("2026-11-12")
    const byType = (type: string) => payments.filter((payment) => payment.type === type)
    expect(byType("loan_installment")[0]).toMatchObject({ name: "Motorbike", number: 2, count: 12, status: "overdue", days_from_today: -33, date: "2026-10-10", amount: { amount: "100", currency: "USD" } })
    expect(byType("loan_installment").find((payment) => payment.name === "Phone plan")).toMatchObject({ amount: { amount: "30", currency: "NIO" }, status: "today", days_from_today: 0 })
    expect(byType("draft")[0]).toMatchObject({ name: "Water", kind: "expense", status: "overdue", days_from_today: -3, rule_id: null })
    expect(byType("card_due")).toEqual([expect.objectContaining({ name: "Visa", due_day: 15, cutoff_day: null, amount: { amount: "200", currency: "USD" }, status: "upcoming", days_from_today: 3 })])
    expect(byType("recurring").map((payment) => [payment.name, payment.status])).toEqual([["Salary", "today"], ["Gym", "upcoming"]])
  })
})
