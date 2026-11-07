import {
  Account,
  Card,
  CategorizationRule,
  Loan,
  PersonalDebt,
  RecurringRule,
  SavingsGoal,
  Settings,
  Transaction,
  TransactionCategory,
} from "../schema"

// Shared cases for the domain contract. keepwell-web is the source; keepwell-api and keepwell-ios
// copy `entities.json` verbatim and run it in their own suites, so a rule that changes in one copy
// and not in the others fails a test instead of diverging in silence.

/** The schema each sync entity is validated with, keyed like `SyncEntity`. */
export const ENTITY_SCHEMAS = {
  account: Account,
  card: Card,
  category: TransactionCategory,
  transaction: Transaction,
  recurringRule: RecurringRule,
  savingsGoal: SavingsGoal,
  loan: Loan,
  personalDebt: PersonalDebt,
  categorizationRule: CategorizationRule,
  settings: Settings,
} as const

export type FixtureEntity = keyof typeof ENTITY_SCHEMAS

export interface FixtureCase {
  name: string
  value: unknown
  /** Invalid cases only: why it must be rejected. */
  reason?: string
}

export interface EntityFixtures {
  version: number
  entities: Record<FixtureEntity, { valid: FixtureCase[]; invalid: FixtureCase[] }>
}
