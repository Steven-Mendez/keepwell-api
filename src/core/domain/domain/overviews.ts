import type { Account, Card, CategorizationRule, CurrencySettings, Loan, PersonalDebt, RecurringRule, SavingsGoal, Settings, Transaction, TransactionCategory } from "../schema"
import { DEFAULT_SETTINGS } from "../schema"

import { addMonths, contains, daysInMonth, sameMonth, yearMonthContaining, zonedParts, type DateInterval, type TimeZone, type YearMonth } from "./calendar"
import { Decimal, ZERO, dec, roundedHalfUp, sum } from "./decimal"
import { DomainError } from "./errors"
import { balanceForecast, type BalanceForecast } from "./forecast"
import { convert, settingsRate, zeroMoney, type Money } from "./money"
import {
  amountIn,
  averageMonthlyTotal,
  balanceOf,
  billingCycle,
  folded,
  inSecondCurrency,
  isConfirmed,
  monthlySummary,
  netWorth,
  excludedCurrencies,
  nextOccurrence,
  plannedSummary,
  priceIncreases,
  principalAmount,
  scopeIncludes,
  subscriptionsCharged,
  type CategoryTotal,
  type MonthlySummary,
  type PlannedSummary,
  type PriceIncrease,
  type TransactionScope,
} from "./rules"
import { orderedCategories, type LedgerStore } from "./store"
import { searchedTag } from "./tags"

// Ports of the feature domains that read the whole ledger: Home, Accounts, CreditCard,
// Transactions, Summary and Settings › Payment methods.

export interface Ledger {
  settings: Settings
  accounts: Account[]
  cards: Card[]
  /** Newest first. */
  transactions: Transaction[]
  categories: TransactionCategory[]
  recurringRules: RecurringRule[]
  savingsGoals: SavingsGoal[]
  loans: Loan[]
  personalDebts: PersonalDebt[]
  /** In the person's order: the first that matches wins. */
  categorizationRules: CategorizationRule[]
  /** The zone its days and months are read in: the store's (`LedgerStore.timeZone`). */
  timeZone: TimeZone
}

export async function loadLedger(store: LedgerStore): Promise<Ledger> {
  const [settings, accounts, cards, transactions, categories, recurringRules, savingsGoals, loans, personalDebts, categorizationRules] = await Promise.all([
    store.loadSettings(),
    store.fetchAccounts(),
    store.fetchCards(),
    store.fetchTransactions(),
    store.fetchCategories(),
    store.fetchRecurringRules(),
    store.fetchSavingsGoals(),
    store.fetchLoans(),
    store.fetchPersonalDebts(),
    store.fetchCategorizationRules(),
  ])
  return {
    settings: settings ?? DEFAULT_SETTINGS,
    accounts,
    cards,
    transactions,
    categories: orderedCategories(categories),
    recurringRules,
    savingsGoals,
    loans,
    personalDebts,
    categorizationRules,
    timeZone: store.timeZone,
  }
}

const newestFirst = (a: Transaction, b: Transaction) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
const oldestFirst = (a: Transaction, b: Transaction) => -newestFirst(a, b)

// Home.

export const HOME_RECENT_COUNT = 3

export interface HomeOverview {
  settings: CurrencySettings
  netWorth: Money
  netWorthInSecond?: Money
  /** Currencies of balances the net worth leaves out (no rate in the settings); empty when none. */
  netWorthExcluded: string[]
  /** Deposit and cash accounts. */
  accountCount: number
  /** Plastics, not transfer channels. */
  cardCount: number
  month: MonthlySummary
  hasTransactions: boolean
  /** Latest confirmed movements, newest first. */
  recent: Transaction[]
  /** Planned movements, soonest first. */
  planned: Transaction[]
  plannedSummary: PlannedSummary
  /** Deposits first, then cash. */
  balances: { account: Account; balance: Money }[]
  /** Every credit card's debt in the principal currency (negative); `undefined` without cards. */
  cardDebt?: Money
  frequentExpenseCategoryIds: string[]
  paymentReminderDaysBefore: number
  /** Services charged to each plastic with an expiry, by card id. */
  cardSubscriptions: Map<string, string[]>
  /** Roughly what bank and cash accounts will hold at month end; `undefined` without any. */
  forecast?: BalanceForecast
  /** Subscriptions whose latest charge cost more than the one before, newest first. */
  priceIncreases: PriceIncrease[]
}

export function homeOverview(ledger: Ledger, now: Date = new Date(), recentCount = HOME_RECENT_COUNT): HomeOverview {
  const currencies = ledger.settings.currencies
  const { accounts, cards, transactions, timeZone: zone } = ledger
  const allBalances: Money[] = []
  let balances: HomeOverview["balances"] = []
  let cardDebt = ZERO
  for (const account of accounts) {
    const accountBalances = balanceOf(account, transactions, zone)
    allBalances.push(...accountBalances)
    if (account.kind === "credit") cardDebt = cardDebt.plus(netWorth(accountBalances, currencies).amount)
    else if (accountBalances[0]) balances.push({ account, balance: accountBalances[0] })
  }
  balances = [...balances.filter((line) => line.account.kind !== "cash"), ...balances.filter((line) => line.account.kind === "cash")]
  const total = netWorth(allBalances, currencies)
  const planned = transactions.filter((transaction) => !isConfirmed(transaction)).sort(oldestFirst)
  const recent = transactions.filter(isConfirmed).sort(newestFirst).slice(0, recentCount)
  const usage = new Map<string, number>()
  for (const transaction of transactions) {
    if (transaction.kind === "expense" && transaction.categoryId) usage.set(transaction.categoryId, (usage.get(transaction.categoryId) ?? 0) + 1)
  }
  const frequent = ledger.categories
    .filter((category) => category.kind === "expense")
    .map((category, index) => ({ id: category.id, index, used: usage.get(category.id) ?? 0 }))
    .sort((a, b) => (a.used === b.used ? a.index - b.index : b.used - a.used))
    .slice(0, 3)
    .map((entry) => entry.id)
  const second = inSecondCurrency(total, currencies)
  return {
    settings: currencies,
    netWorth: total,
    ...(second ? { netWorthInSecond: second } : {}),
    netWorthExcluded: excludedCurrencies(allBalances, currencies),
    accountCount: accounts.filter((account) => account.kind !== "credit").length,
    cardCount: cards.filter((card) => card.kind !== "transfer").length,
    month: monthlySummary(yearMonthContaining(now, zone), transactions, currencies.principal, zone),
    hasTransactions: transactions.length > 0,
    recent,
    planned,
    plannedSummary: plannedSummary(planned),
    balances,
    ...(accounts.some((account) => account.kind === "credit") ? { cardDebt: { amount: cardDebt, currency: currencies.principal } } : {}),
    frequentExpenseCategoryIds: frequent,
    paymentReminderDaysBefore: ledger.settings.paymentReminderDaysBefore,
    cardSubscriptions: new Map(cards.filter((card) => card.expiry).map((card) => [card.id, subscriptionsCharged(card.id, transactions, zone, ledger.recurringRules)])),
    ...(accounts.some((account) => account.kind !== "credit")
      ? { forecast: balanceForecast(accounts, transactions, ledger.recurringRules, currencies, zone, now) }
      : {}),
    priceIncreases: priceIncreases(transactions, zone, now),
  }
}

// Accounts.

export interface AccountsOverview {
  settings: CurrencySettings
  netWorth: Money
  /** Debts per currency, negative, second currency first as the cards show them. */
  creditCards: { account: Account; holder?: Card; balances: Money[] }[]
  deposits: { account: Account; balance: Money; debitCard?: Card }[]
  cash: { account: Account; balance: Money; principalEquivalent?: Money }[]
}

export function accountsOverview(accounts: readonly Account[], cards: readonly Card[], transactions: readonly Transaction[], currencies: CurrencySettings, zone: TimeZone): AccountsOverview {
  const result: AccountsOverview = { settings: currencies, netWorth: zeroMoney(currencies.principal), creditCards: [], deposits: [], cash: [] }
  const all: Money[] = []
  for (const account of accounts) {
    const balances = balanceOf(account, transactions, zone)
    all.push(...balances)
    const own = cards.filter((card) => card.accountId === account.id)
    switch (account.kind) {
      case "credit": {
        const holder = own.find((card) => card.kind === "creditHolder")
        result.creditCards.push({ account, ...(holder ? { holder } : {}), balances: [...balances].reverse() })
        break
      }
      case "deposit": {
        const debitCard = own.find((card) => card.kind === "debit")
        result.deposits.push({ account, balance: balances[0] ?? zeroMoney(currencies.principal), ...(debitCard ? { debitCard } : {}) })
        break
      }
      case "cash": {
        const balance = balances[0] ?? zeroMoney(currencies.principal)
        let principalEquivalent: Money | undefined
        if (balance.currency !== currencies.principal) {
          try {
            principalEquivalent = convert(balance, settingsRate(currencies), currencies.principal)
          } catch {
            principalEquivalent = undefined
          }
        }
        result.cash.push({ account, balance, ...(principalEquivalent ? { principalEquivalent } : {}) })
      }
    }
  }
  result.netWorth = netWorth(all, currencies)
  return result
}

export const DEBIT_LATEST_COUNT = 5

export interface DebitCardDetail {
  card: Card
  account: Account
  balance: Money
  /** Every movement that touches the account, planned ones included: what deleting it removes. */
  movementCount: number
  /** Latest confirmed movements, newest first. */
  latestTransactions: Transaction[]
}

export function debitCardDetail(ledger: Ledger, accountId: string): DebitCardDetail {
  const account = ledger.accounts.find((candidate) => candidate.id === accountId && candidate.kind === "deposit")
  if (!account) throw DomainError.notFound(accountId)
  const card = ledger.cards.find((candidate) => candidate.accountId === accountId && candidate.kind === "debit")
  if (!card) throw DomainError.notFound(accountId)
  const balance = balanceOf(account, ledger.transactions, ledger.timeZone)[0] ?? zeroMoney(ledger.settings.currencies.principal)
  const touching = ledger.transactions.filter((transaction) => scopeIncludes({ kind: "account", id: accountId }, transaction))
  return {
    card,
    account,
    balance,
    movementCount: touching.length,
    latestTransactions: touching.filter(isConfirmed).sort(newestFirst).slice(0, DEBIT_LATEST_COUNT),
  }
}

export interface CreditCardDetail {
  account: Account
  holder?: Card
  /** Debt per currency, negative, in the order the account holds them. */
  balances: Money[]
  /** The whole debt in the principal currency (negative). */
  totalDebt: Money
  /** Limit minus what's owed, in the limit's currency. */
  available?: Money
  cycle: DateInterval
  /** Confirmed and planned movements charged to the card this cycle, newest first. */
  cycleTransactions: Transaction[]
  nextCutoff?: Date
  nextDue?: Date
  /** The currency the limit is kept in. */
  limitCurrency: string
}

export function creditCardDetail(ledger: Ledger, accountId: string, now: Date = new Date()): CreditCardDetail {
  const account = ledger.accounts.find((candidate) => candidate.id === accountId && candidate.kind === "credit")
  if (!account) throw DomainError.notFound(accountId)
  const currencies = ledger.settings.currencies
  const zone = ledger.timeZone
  const balances = balanceOf(account, ledger.transactions, zone)
  const totalDebt = netWorth(balances, currencies)
  const terms = account.creditTerms
  const cycle = billingCycle(now, terms?.cutoffDay, zone)
  let available: Money | undefined
  if (terms?.limit) {
    try {
      const owed = convert(totalDebt, settingsRate(currencies), terms.limit.currency)
      available = { amount: dec(terms.limit.amount).plus(owed.amount), currency: terms.limit.currency }
    } catch {
      // A limit in a currency the settings no longer convert: no "available" rather than a wrong one.
      available = undefined
    }
  }
  const holder = ledger.cards.find((card) => card.accountId === accountId && card.kind === "creditHolder")
  return {
    account,
    ...(holder ? { holder } : {}),
    balances,
    totalDebt,
    ...(available ? { available } : {}),
    cycle,
    cycleTransactions: ledger.transactions.filter((t) => t.accountId === accountId && contains(cycle, new Date(t.date))).sort(newestFirst),
    ...(terms?.cutoffDay ? { nextCutoff: nextOccurrence(terms.cutoffDay, now, zone) } : {}),
    ...(terms?.dueDay ? { nextDue: nextOccurrence(terms.dueDay, now, zone) } : {}),
    limitCurrency: terms?.limit?.currency ?? (terms?.debtMode === "second" ? currencies.second : undefined) ?? currencies.principal,
  }
}

// Transactions list.

/** Planned movements show only under `planned`, since they don't count yet. */
export type TransactionFilter = "all" | "expense" | "income" | "transfer" | "planned"
export const TRANSACTION_FILTERS: readonly TransactionFilter[] = ["all", "expense", "income", "transfer", "planned"]

export function filterMatches(filter: TransactionFilter, transaction: Transaction): boolean {
  if (filter === "all") return true
  if (filter === "planned") return !isConfirmed(transaction)
  return isConfirmed(transaction) && transaction.kind === filter
}

/** Bounds on a movement's amount in the principal currency, both inclusive; either may be left out. */
export interface AmountRange {
  min?: Decimal
  max?: Decimal
}

/** Where a movement came from: anything, a subscription's rule, or one recurring rule. */
export type TransactionOrigin = { kind: "any" } | { kind: "subscriptions" } | { kind: "rule"; id: string }

const ANY_ORIGIN: TransactionOrigin = { kind: "any" }

/** Why a range can't be applied; `undefined` when it can. */
export function amountRangeError(range: AmountRange): "minAboveMax" | undefined {
  return range.min !== undefined && range.max !== undefined && range.min.gt(range.max) ? "minAboveMax" : undefined
}

/**
 * Whether the movement's amount in the principal currency, converted with the rate it recorded
 * (the figure the totals strip adds up), falls in the range. Compared rounded to cents, as shown:
 * 99.996 reads 100.00 and passes "at least 100". A range with `min` above `max` matches nothing.
 */
export function amountInRange(transaction: Transaction, range: AmountRange, principal: string): boolean {
  if (amountRangeError(range)) return false
  const amount = roundedHalfUp(amountIn(transaction, principal), 2)
  if (range.min !== undefined && amount.lt(range.min)) return false
  if (range.max !== undefined && amount.gt(range.max)) return false
  return true
}

/**
 * Whether the movement came from the origin. A rule matches by `recurringId`, even once deleted;
 * a subscription needs the rule to still exist and be one today (paused counts). Movements logged
 * by hand match neither.
 */
export function originMatches(transaction: Transaction, origin: TransactionOrigin, rules: readonly RecurringRule[]): boolean {
  switch (origin.kind) {
    case "any":
      return true
    case "rule":
      return transaction.recurringId === origin.id
    case "subscriptions":
      return transaction.recurringId !== undefined && rules.some((rule) => rule.id === transaction.recurringId && rule.isSubscription)
  }
}

export interface TransactionQuery {
  kind: TransactionFilter
  scope: TransactionScope
  text: string
  /** Read in `context.principal`; left out, amounts don't narrow. */
  amount?: AmountRange
  /** Read against `context.rules`; left out, every origin passes. */
  origin?: TransactionOrigin
}

/** What the amount and origin filters read: the principal currency and the recurring rules. */
export interface TransactionQueryContext {
  principal: string
  rules: readonly RecurringRule[]
}

/**
 * Narrows movements; `searchableText` is presentation (translated category, method name). A search
 * like "#boda" narrows to that tag instead of the text (iOS `TransactionQuery.tag`). The amount and
 * origin filters apply only with a `context`.
 */
export function filterTransactions(
  transactions: readonly Transaction[],
  query: TransactionQuery,
  searchableText: (transaction: Transaction) => string,
  context?: TransactionQueryContext,
): Transaction[] {
  const needle = folded(query.text.trim())
  const tag = searchedTag(query.text)
  const matchesText = (transaction: Transaction) =>
    tag !== undefined ? (transaction.tags ?? []).includes(tag) : needle === "" || folded(searchableText(transaction)).includes(needle)
  const range = query.amount
  const narrowsAmount = range !== undefined && (range.min !== undefined || range.max !== undefined)
  const origin = query.origin ?? ANY_ORIGIN
  const matchesExtras = (transaction: Transaction) =>
    context === undefined ||
    ((!narrowsAmount || amountInRange(transaction, range, context.principal)) && originMatches(transaction, origin, context.rules))
  return transactions.filter(
    (transaction) => filterMatches(query.kind, transaction) && scopeIncludes(query.scope, transaction) && matchesText(transaction) && matchesExtras(transaction),
  )
}

/** Accounts in the Accounts tab's order (credit, bank, cash), each with the card that is its face. */
export function scopeOptions(accounts: readonly Account[], cards: readonly Card[]): { account: Account; card?: Card }[] {
  return (["credit", "deposit", "cash"] as const).flatMap((kind) =>
    accounts
      .filter((account) => account.kind === kind)
      .map((account) => {
        const face = kind === "deposit" ? "debit" : kind === "credit" ? "creditHolder" : undefined
        const card = face ? cards.find((candidate) => candidate.accountId === account.id && candidate.kind === face) : undefined
        return { account, ...(card ? { card } : {}) }
      }),
  )
}

// Summary.

export type CashFlowOutcome = { kind: "saved"; amount: Decimal } | { kind: "overspent"; amount: Decimal } | { kind: "even" } | { kind: "noActivity" }

export function cashFlowOutcome(income: Decimal, expense: Decimal): CashFlowOutcome {
  const net = income.minus(expense)
  if (income.isZero() && expense.isZero()) return { kind: "noActivity" }
  if (net.gt(0)) return { kind: "saved", amount: net }
  if (net.lt(0)) return { kind: "overspent", amount: net.neg() }
  return { kind: "even" }
}

export interface CashFlowTrend {
  income: Decimal
  expense: Decimal
  monthsSaved: number
  monthsOverspent: number
}

export function cashFlowTrend(months: readonly MonthlySummary[]): CashFlowTrend {
  const outcomes = months.map((month) => cashFlowOutcome(month.income, month.expense).kind)
  return {
    income: sum(months.map((month) => month.income)),
    expense: sum(months.map((month) => month.expense)),
    monthsSaved: outcomes.filter((kind) => kind === "saved").length,
    monthsOverspent: outcomes.filter((kind) => kind === "overspent").length,
  }
}

export type BreakdownSlice = { kind: "category"; id: string } | { kind: "others"; count: number }

export interface CategoryBreakdown {
  total: Decimal
  /** Largest first; the grouped slice, when there is one, last. */
  entries: { slice: BreakdownSlice; amount: Decimal; share: Decimal }[]
}

export const MAX_NAMED_SLICES = 5

/** The largest categories by name and the long tail folded into one slice; `totals` ranked largest first. */
export function categoryBreakdown(totals: readonly CategoryTotal[], maxNamed = MAX_NAMED_SLICES): CategoryBreakdown {
  const total = sum(totals.map((entry) => entry.amount))
  const shareOf = (amount: Decimal) => (total.gt(0) ? amount.div(total) : ZERO)
  // Folding a single category into "others" would only hide its name.
  const named = totals.length > maxNamed + 1 ? totals.slice(0, maxNamed) : [...totals]
  const entries: CategoryBreakdown["entries"] = named.map((entry) => ({ slice: { kind: "category", id: entry.categoryId }, amount: entry.amount, share: shareOf(entry.amount) }))
  const rest = totals.slice(named.length)
  if (rest.length > 0) {
    const amount = sum(rest.map((entry) => entry.amount))
    entries.push({ slice: { kind: "others", count: rest.length }, amount, share: shareOf(amount) })
  }
  return { total, entries }
}

export interface SpendingPace {
  month: YearMonth
  previousMonth: YearMonth
  /** Cumulative spending per day, through today for the running month. */
  current: { day: number; cumulative: Decimal }[]
  previous: { day: number; cumulative: Decimal }[]
}

function pacePoints(month: YearMonth, lastDay: number, transactions: readonly Transaction[], zone: TimeZone) {
  const perDay = new Map<number, Decimal>()
  for (const transaction of transactions) {
    const date = zonedParts(new Date(transaction.date), zone)
    if (!isConfirmed(transaction) || transaction.kind !== "expense" || !sameMonth(date, month)) continue
    perDay.set(date.day, (perDay.get(date.day) ?? ZERO).plus(principalAmount(transaction)))
  }
  let running = ZERO
  return Array.from({ length: Math.max(lastDay, 1) }, (_, index) => {
    running = running.plus(perDay.get(index + 1) ?? ZERO)
    return { day: index + 1, cumulative: running }
  })
}

export function spendingPace(month: YearMonth, transactions: readonly Transaction[], now: Date, zone: TimeZone): SpendingPace {
  const previousMonth = addMonths(month, -1)
  const days = daysInMonth(month)
  const today = zonedParts(now, zone)
  const lastDay = sameMonth(today, month) ? Math.min(today.day, days) : days
  return { month, previousMonth, current: pacePoints(month, lastDay, transactions, zone), previous: pacePoints(previousMonth, daysInMonth(previousMonth), transactions, zone) }
}

export const paceComparisonDay = (pace: SpendingPace) => pace.current.at(-1)?.day ?? 1
export const paceSpentSoFar = (pace: SpendingPace) => pace.current.at(-1)?.cumulative ?? ZERO
/** The previous month by the same day; its last day when it was shorter. */
export const pacePreviousBySameDay = (pace: SpendingPace) => [...pace.previous].reverse().find((point) => point.day <= paceComparisonDay(pace))?.cumulative ?? ZERO
export const pacePreviousTotal = (pace: SpendingPace) => pace.previous.at(-1)?.cumulative ?? ZERO
export const paceDifference = (pace: SpendingPace) => paceSpentSoFar(pace).minus(pacePreviousBySameDay(pace))

export const SUMMARY_MONTH_COUNT = 6

export interface SummaryReport {
  currency: string
  /** Oldest first; the last one is the current month. */
  months: MonthlySummary[]
  averageExpense?: Decimal
  averageIncome?: Decimal
  cashFlow: CashFlowTrend
  expenseBreakdowns: CategoryBreakdown[]
  incomeBreakdowns: CategoryBreakdown[]
  paces: SpendingPace[]
}

export function summaryReport(transactions: readonly Transaction[], currency: string, zone: TimeZone, now: Date = new Date(), count = SUMMARY_MONTH_COUNT): SummaryReport {
  const current = yearMonthContaining(now, zone)
  const months = Array.from({ length: count }, (_, index) => monthlySummary(addMonths(current, index - (count - 1)), transactions, currency, zone))
  const averageExpense = averageMonthlyTotal("expense", transactions, zone)
  const averageIncome = averageMonthlyTotal("income", transactions, zone)
  return {
    currency,
    months,
    ...(averageExpense ? { averageExpense } : {}),
    ...(averageIncome ? { averageIncome } : {}),
    cashFlow: cashFlowTrend(months),
    expenseBreakdowns: months.map((month) => categoryBreakdown(month.categories)),
    incomeBreakdowns: months.map((month) => categoryBreakdown(month.incomeCategories)),
    paces: months.map((month) => spendingPace(month.month, transactions, now, zone)),
  }
}

// Settings › Payment methods: every method grouped by its account; cash has none.

export function paymentMethodGroups(accounts: readonly Account[], cards: readonly Card[]): { account: Account; methods: Card[] }[] {
  return accounts.flatMap((account) => {
    const methods = cards.filter((card) => card.accountId === account.id)
    if (methods.length === 0) return []
    return [{ account, methods: [...methods.filter((card) => card.kind !== "transfer"), ...methods.filter((card) => card.kind === "transfer")] }]
  })
}
