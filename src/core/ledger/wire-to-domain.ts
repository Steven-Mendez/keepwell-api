import type {
  Account,
  Card,
  CategorizationRule,
  Loan,
  PersonalDebt,
  RecurringRule,
  SavingsGoal,
  Settings,
  SyncEntity,
  SyncRow,
  Transaction,
  TransactionCategory,
} from "../domain/schema"
import { DEFAULT_SETTINGS } from "../domain/schema"

// Wire rows (snake_case, as stored) → domain objects, so the server computes with the same domain
// functions the apps use. The inverse of keepwell-web's `rowTo*` mappers; tests/mcp checks it
// against rows built from the shared fixtures.

type Row<E extends SyncEntity> = SyncRow<E>

const present = <K extends string, T>(key: K, value: T | null | undefined): { [P in K]?: T } =>
  (value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: T }
const tags = (value: string[] | undefined) => (value && value.length > 0 ? { tags: value } : {})

export interface LedgerRows {
  account: Row<"account">[]
  card: Row<"card">[]
  category: Row<"category">[]
  transaction: (Row<"transaction"> & { source?: string })[]
  recurringRule: (Row<"recurringRule"> & { source?: string })[]
  savingsGoal: Row<"savingsGoal">[]
  loan: Row<"loan">[]
  loanPayment: Row<"loanPayment">[]
  personalDebt: Row<"personalDebt">[]
  personalDebtRepayment: Row<"personalDebtRepayment">[]
  categorizationRule: Row<"categorizationRule">[]
  settings: Row<"settings">[]
  notificationState: Row<"notificationState">[]
}

const alive = <T extends { deleted_at: string | null }>(rows: T[]) => rows.filter((row) => row.deleted_at === null)

export function toDomain(rows: LedgerRows) {
  const accounts: Account[] = alive(rows.account).map((row) => ({
    id: row.id,
    name: row.name,
    ...present("bank", row.bank),
    kind: row.kind,
    openingBalances: row.opening_balances.map(({ amount, currency }) => ({ amount, currency })),
    openingDate: row.opening_date,
    ...(row.debt_mode
      ? {
          creditTerms: {
            debtMode: row.debt_mode,
            ...(row.limit_amount && row.limit_currency ? { limit: { amount: row.limit_amount, currency: row.limit_currency } } : {}),
            ...present("cutoffDay", row.cutoff_day),
            ...present("dueDay", row.due_day),
          },
        }
      : {}),
  }))
  const cards: Card[] = alive(rows.card).map((row) => ({
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    ...present("network", row.network),
    ...present("lastFour", row.last_four),
    ...present("color", row.color),
    ...present("productName", row.product_name),
    ...(row.expiry_month && row.expiry_year ? { expiry: { month: row.expiry_month, year: row.expiry_year } } : {}),
  }))
  const categories: TransactionCategory[] = alive(rows.category)
    .sort((a, b) => a.sort_index - b.sort_index)
    .map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      ...present("icon", row.icon),
      ...present("color", row.color),
      isRenamed: row.is_renamed,
      ...(row.budget_amount && row.budget_currency ? { monthlyBudget: { amount: row.budget_amount, currency: row.budget_currency } } : {}),
    }))
  const transactions: Transaction[] = alive(rows.transaction)
    .map((row) => ({
      id: row.id,
      date: row.date,
      status: row.status,
      description: row.description,
      kind: row.kind,
      ...present("categoryId", row.category_id),
      amount: row.amount,
      currency: row.currency,
      accountId: row.account_id,
      ...present("cardId", row.card_id),
      ...present("destinationAccountId", row.destination_account_id),
      ...present("actualDebitedPrincipal", row.actual_debited_principal),
      exchangeRate: { principal: row.rate_principal, second: row.rate_second, rate: row.rate },
      isShared: row.is_shared,
      ...present("note", row.note),
      ...present("recurringId", row.recurring_id),
      ...tags(row.tags),
      ...(row.source === "mcp" ? { source: "mcp" as const } : {}),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const recurringRules: RecurringRule[] = alive(rows.recurringRule).map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    ...present("categoryId", row.category_id),
    amount: row.amount,
    currency: row.currency,
    accountId: row.account_id,
    ...present("cardId", row.card_id),
    ...present("destinationAccountId", row.destination_account_id),
    frequency: row.frequency,
    interval: row.interval,
    startDate: row.start_date,
    nextDate: row.next_date,
    ...present("endDate", row.end_date),
    isSubscription: row.is_subscription,
    autoConfirm: row.auto_confirm,
    isPaused: row.is_paused,
    ...present("note", row.note),
    ...tags(row.tags),
    ...(row.source === "mcp" ? { source: "mcp" as const } : {}),
  }))
  const savingsGoals: SavingsGoal[] = alive(rows.savingsGoal).map((row) => ({
    id: row.id,
    name: row.name,
    target: { amount: row.target_amount, currency: row.target_currency },
    saved: row.saved,
    ...(row.target_month && row.target_year ? { targetMonth: { month: row.target_month, year: row.target_year } } : {}),
    ...present("icon", row.icon),
    ...present("color", row.color),
  }))
  const payments = alive(rows.loanPayment)
  const loans: Loan[] = alive(rows.loan).map((row) => ({
    id: row.id,
    name: row.name,
    ...present("lender", row.lender),
    borrowed: { amount: row.borrowed_amount, currency: row.borrowed_currency },
    installmentAmount: row.installment_amount,
    installmentCount: row.installment_count,
    frequency: row.frequency,
    firstDueDate: row.first_due_date,
    payments: payments
      .filter((payment) => payment.loan_id === row.id)
      .sort((a, b) => a.number - b.number)
      .map((payment) => ({ id: payment.id, number: payment.number, paidAt: payment.paid_at, ...present("transactionId", payment.transaction_id) })),
  }))
  const repayments = alive(rows.personalDebtRepayment)
  const personalDebts: PersonalDebt[] = alive(rows.personalDebt).map((row) => ({
    id: row.id,
    person: row.person,
    direction: row.direction,
    amount: { amount: row.amount, currency: row.currency },
    date: row.date,
    ...present("note", row.note),
    repayments: repayments
      .filter((repayment) => repayment.debt_id === row.id)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((repayment) => ({ id: repayment.id, amount: repayment.amount, date: repayment.date })),
    ...present("settledAt", row.settled_at),
    ...present("transactionId", row.transaction_id),
  }))
  // Two offline devices can give rules the same `sort_index`; the `id` breaks the tie as the apps do,
  // so every platform picks the same winning rule.
  const categorizationRules: CategorizationRule[] = alive(rows.categorizationRule)
    .sort((a, b) => a.sort_index - b.sort_index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => ({ id: row.id, match: row.match, categoryId: row.category_id, kind: row.kind, ...tags(row.tags) }))
  const stored = alive(rows.settings)[0]
  // Device preferences don't sync; the server uses the defaults, which no computation here reads.
  const settings: Settings = stored
    ? {
        ...DEFAULT_SETTINGS,
        currencies: stored.second ? { principal: stored.principal, second: stored.second, rate: stored.rate } : { principal: stored.principal, rate: "1" },
        paymentReminderDaysBefore: stored.payment_reminder_days_before,
        hasCompletedOnboarding: stored.has_completed_onboarding,
        ...present("timeZone", stored.time_zone),
      }
    : DEFAULT_SETTINGS
  return { accounts, cards, categories, transactions, recurringRules, savingsGoals, loans, personalDebts, categorizationRules, settings }
}

/** Domain → wire, for rows the server itself writes (materialized occurrences, MCP writes). */
export function transactionToWire(transaction: Transaction, audit: { created_at: string; updated_at: string }): SyncRow<"transaction"> {
  return {
    id: transaction.id,
    date: transaction.date,
    status: transaction.status,
    description: transaction.description,
    kind: transaction.kind,
    category_id: transaction.categoryId ?? null,
    amount: transaction.amount,
    currency: transaction.currency,
    account_id: transaction.accountId,
    card_id: transaction.cardId ?? null,
    destination_account_id: transaction.destinationAccountId ?? null,
    actual_debited_principal: transaction.actualDebitedPrincipal ?? null,
    rate_principal: transaction.exchangeRate.principal,
    rate_second: transaction.exchangeRate.second,
    rate: transaction.exchangeRate.rate,
    is_shared: transaction.isShared,
    note: transaction.note ?? null,
    recurring_id: transaction.recurringId ?? null,
    tags: transaction.tags ?? [],
    ...audit,
    deleted_at: null,
  }
}

export function recurringRuleToWire(rule: RecurringRule, audit: { created_at: string; updated_at: string }): SyncRow<"recurringRule"> {
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    category_id: rule.categoryId ?? null,
    amount: rule.amount,
    currency: rule.currency,
    account_id: rule.accountId,
    card_id: rule.cardId ?? null,
    destination_account_id: rule.destinationAccountId ?? null,
    frequency: rule.frequency,
    interval: rule.interval,
    start_date: rule.startDate,
    next_date: rule.nextDate,
    end_date: rule.endDate ?? null,
    is_subscription: rule.isSubscription,
    auto_confirm: rule.autoConfirm,
    is_paused: rule.isPaused,
    note: rule.note ?? null,
    tags: rule.tags ?? [],
    ...audit,
    deleted_at: null,
  }
}
