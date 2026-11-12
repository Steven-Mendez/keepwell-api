import type { Ledger } from "../../src/core/domain/domain"
import type { UpcomingFixtures } from "../../src/core/domain/fixtures"
import { Account, CurrencySettings, DEFAULT_SETTINGS, Loan, RecurringRule, Transaction } from "../../src/core/domain/schema"

/** A shared `upcoming.json` case as the domain reads it: every entity through its schema, like a synced row. */
export function upcomingFixtureLedger(entry: UpcomingFixtures["cases"][number]): Ledger {
  return {
    settings: { ...DEFAULT_SETTINGS, currencies: CurrencySettings.parse(entry.ledger.currencies) },
    accounts: entry.ledger.accounts.map((value) => Account.parse(value)),
    cards: [],
    transactions: entry.ledger.transactions.map((value) => Transaction.parse(value)),
    categories: [],
    recurringRules: entry.ledger.recurringRules.map((value) => RecurringRule.parse(value)),
    savingsGoals: [],
    loans: entry.ledger.loans.map((value) => Loan.parse(value)),
    personalDebts: [],
    categorizationRules: [],
    timeZone: entry.timeZone,
  }
}
