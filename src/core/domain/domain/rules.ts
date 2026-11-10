import type { Account, Card, CurrencySettings, RecurringRule, Transaction, TransactionKind } from "../schema"
import { OTHER_EXPENSE_ID, OTHER_INCOME_ID } from "../schema"

import {
  addDays,
  addMonths,
  daysInMonth,
  monthInterval,
  monthKey,
  sameMonth,
  startOfDay,
  yearMonthContaining,
  type DateInterval,
  type YearMonth,
} from "./calendar"
import { Decimal, ZERO, dec, sum } from "./decimal"
import { DomainError } from "./errors"
import { convert, fromStored, rateHasSecondCurrency, settingsRate, type Money } from "./money"

// Ports of keepwell-ios Packages/Domain/Sources/Domain/Rules: the HANDOFF rules every screen shares.

export const isConfirmed = (transaction: Transaction) => transaction.status === "confirmed"
const dateOf = (transaction: Transaction) => new Date(transaction.date)

/** "`amount` is always positive"; a known bank charge must be positive too (iOS `checkAmounts`). */
export function checkAmounts(amount: Decimal, actualDebitedPrincipal?: Decimal): void {
  if (amount.lte(0) || (actualDebitedPrincipal !== undefined && actualDebitedPrincipal.lte(0))) throw DomainError.invalidAmount()
}

// Rule 2: conversion, always with the rate stored on the transaction.

function isInSecondCurrency(transaction: Transaction): boolean {
  return rateHasSecondCurrency(transaction.exchangeRate) && transaction.currency === transaction.exchangeRate.second
}

/** The real debit if the bank reported one; otherwise the amount, converted when in the second currency. */
export function principalAmount(transaction: Transaction): Decimal {
  if (transaction.actualDebitedPrincipal !== undefined) return dec(transaction.actualDebitedPrincipal)
  const amount = dec(transaction.amount)
  return isInSecondCurrency(transaction) ? amount.div(dec(transaction.exchangeRate.rate)) : amount
}

/** The amount itself when in the second currency; otherwise the principal amount (real debit first) times the rate. */
export function secondAmount(transaction: Transaction): Decimal {
  if (isInSecondCurrency(transaction)) return dec(transaction.amount)
  return dec(transaction.actualDebitedPrincipal ?? transaction.amount).times(dec(transaction.exchangeRate.rate))
}

/** The amount in `currency`, which must be one of the transaction's two currencies. */
export function amountIn(transaction: Transaction, currency: string): Decimal {
  return currency === transaction.exchangeRate.second && rateHasSecondCurrency(transaction.exchangeRate)
    ? secondAmount(transaction)
    : principalAmount(transaction)
}

/** The rate the bank effectively applied (second per principal), when it reported a real debit. */
export function bankRate(transaction: Transaction): Decimal | undefined {
  if (transaction.actualDebitedPrincipal === undefined || !isInSecondCurrency(transaction)) return undefined
  const debited = dec(transaction.actualDebitedPrincipal)
  return debited.gt(0) ? dec(transaction.amount).div(debited) : undefined
}

// Rules 1, 3, 4, 5: balances.

export function accountCurrencies(account: Account): string[] {
  return account.openingBalances.map((balance) => balance.currency)
}

/** +1 when money enters the account, −1 when it leaves, 0 when the movement doesn't touch it. */
export function direction(transaction: Transaction, accountId: string): -1 | 0 | 1 {
  switch (transaction.kind) {
    case "expense":
      return transaction.accountId === accountId ? -1 : 0
    case "income":
      return transaction.accountId === accountId ? 1 : 0
    case "transfer":
      if (transaction.accountId === accountId) return -1
      return transaction.destinationAccountId === accountId ? 1 : 0
  }
}

/** Which of the account's currencies the movement hits; a dual card books each purchase in its own currency. */
export function share(transaction: Transaction, account: Account): { currency: string; amount: Decimal } {
  const currencies = accountCurrencies(account)
  if (currencies.length > 1) {
    if (currencies.includes(transaction.currency)) return { currency: transaction.currency, amount: dec(transaction.amount) }
    const principal = currencies[0] as string
    return { currency: principal, amount: amountIn(transaction, principal) }
  }
  const currency = currencies[0] ?? transaction.currency
  return { currency, amount: amountIn(transaction, currency) }
}

/** Opening balance plus confirmed inflows minus outflows since the opening day, one per currency. */
export function balanceOf(account: Account, transactions: readonly Transaction[]): Money[] {
  const openingDay = startOfDay(new Date(account.openingDate)).getTime()
  const totals = new Map<string, Decimal>(account.openingBalances.map((balance) => [balance.currency, dec(balance.amount)]))
  for (const transaction of transactions) {
    if (!isConfirmed(transaction) || dateOf(transaction).getTime() < openingDay) continue
    const sign = direction(transaction, account.id)
    if (sign === 0) continue
    const { currency, amount } = share(transaction, account)
    totals.set(currency, (totals.get(currency) ?? ZERO).plus(amount.times(sign)))
  }
  return accountCurrencies(account).map((currency) => ({ amount: totals.get(currency) ?? ZERO, currency }))
}

// Rule 6: net worth, with today's settings rate.

/** A balance in a currency the settings no longer convert is left out rather than mixed in, as in the forecast. */
export function netWorth(balances: readonly Money[], settings: CurrencySettings): Money {
  const rate = settingsRate(settings)
  const amounts = balances.flatMap((balance) => {
    try {
      return [convert(balance, rate, settings.principal).amount]
    } catch {
      return []
    }
  })
  return { amount: sum(amounts), currency: settings.principal }
}

export function inSecondCurrency(total: Money, settings: CurrencySettings): Money | undefined {
  if (settings.second === undefined) return undefined
  try {
    return convert(total, settingsRate(settings), settings.second)
  } catch {
    return undefined
  }
}

// Rule 7: monthly summary, in the principal currency.

export interface CategoryTotal {
  categoryId: string
  amount: Decimal
  /** Share of the month's total (0…1). */
  share: Decimal
}

export interface MonthlySummary {
  month: YearMonth
  currency: string
  income: Decimal
  expense: Decimal
  /** Spending per category, largest first. */
  categories: CategoryTotal[]
  /** Income per category, largest first. */
  incomeCategories: CategoryTotal[]
}

function ranked(totals: Map<string, Decimal>, total: Decimal): CategoryTotal[] {
  return [...totals.entries()]
    .map(([categoryId, amount]) => ({ categoryId, amount, share: total.gt(0) ? amount.div(total) : ZERO }))
    .sort((a, b) => (a.amount.eq(b.amount) ? (a.categoryId < b.categoryId ? -1 : 1) : b.amount.cmp(a.amount)))
}

export function monthlySummary(month: YearMonth, transactions: readonly Transaction[], currency: string): MonthlySummary {
  let income = ZERO
  let expense = ZERO
  const perCategory = new Map<string, Decimal>()
  const perIncome = new Map<string, Decimal>()
  for (const transaction of transactions) {
    if (!isConfirmed(transaction) || !sameMonth(yearMonthContaining(dateOf(transaction)), month)) continue
    const amount = principalAmount(transaction)
    if (transaction.kind === "income") {
      income = income.plus(amount)
      const id = transaction.categoryId ?? OTHER_INCOME_ID
      perIncome.set(id, (perIncome.get(id) ?? ZERO).plus(amount))
    } else if (transaction.kind === "expense") {
      expense = expense.plus(amount)
      const id = transaction.categoryId ?? OTHER_EXPENSE_ID
      perCategory.set(id, (perCategory.get(id) ?? ZERO).plus(amount))
    }
  }
  return { month, currency, income, expense, categories: ranked(perCategory, expense), incomeCategories: ranked(perIncome, income) }
}

export const savings = (summary: { income: Decimal; expense: Decimal }) => summary.income.minus(summary.expense)

/** `savings / income`; `undefined` without income, since 0% would hide overspending. */
export function savingsRate(summary: { income: Decimal; expense: Decimal }): Decimal | undefined {
  return summary.income.gt(0) ? savings(summary).div(summary.income) : undefined
}

function totalsByMonth(kind: TransactionKind, transactions: readonly Transaction[]): Map<string, Decimal> {
  const totals = new Map<string, Decimal>()
  for (const transaction of transactions) {
    if (!isConfirmed(transaction) || transaction.kind !== kind) continue
    const key = monthKey(yearMonthContaining(dateOf(transaction)))
    totals.set(key, (totals.get(key) ?? ZERO).plus(principalAmount(transaction)))
  }
  return totals
}

/** Monthly totals of one kind for `count` months ending at `last`, oldest first. */
export function monthlyTotals(kind: TransactionKind, last: YearMonth, count: number, transactions: readonly Transaction[]) {
  const totals = totalsByMonth(kind, transactions)
  return Array.from({ length: count }, (_, index) => {
    const month = addMonths(last, index - (count - 1))
    return { month, total: totals.get(monthKey(month)) ?? ZERO }
  })
}

/** Average over the months that have any movement of that kind; `undefined` when there are none. */
export function averageMonthlyTotal(kind: TransactionKind, transactions: readonly Transaction[]): Decimal | undefined {
  const totals = [...totalsByMonth(kind, transactions).values()].filter((total) => total.gt(0))
  return totals.length === 0 ? undefined : sum(totals).div(totals.length)
}

export interface PlannedSummary {
  count: number
  principalTotal: Decimal
  secondTotal: Decimal
}

/** Planned movements waiting for confirmation, in both currencies. */
export function plannedSummary(transactions: readonly Transaction[]): PlannedSummary {
  const planned = transactions.filter((transaction) => !isConfirmed(transaction))
  return {
    count: planned.length,
    principalTotal: sum(planned.map(principalAmount)),
    secondTotal: sum(planned.map(secondAmount)),
  }
}

// Billing cycle: from the day after the previous cutoff through the cutoff day; days past a
// month's end clamp to its last day.

function cutoffIn(month: YearMonth, day: number): Date {
  return new Date(month.year, month.month - 1, Math.min(day, daysInMonth(month)))
}

export function billingCycle(date: Date, cutoffDay: number | undefined): DateInterval {
  const month = yearMonthContaining(date)
  if (cutoffDay === undefined) return monthInterval(month)
  const thisCutoff = cutoffIn(month, cutoffDay)
  const day = startOfDay(date)
  const [startCutoff, endCutoff] =
    day.getTime() <= thisCutoff.getTime()
      ? [cutoffIn(addMonths(month, -1), cutoffDay), thisCutoff]
      : [thisCutoff, cutoffIn(addMonths(month, 1), cutoffDay)]
  return { start: addDays(startCutoff, 1), end: addDays(endCutoff, 1) }
}

/**
 * The last cutoff before `due`'s day: the statement a payment due that day settles (iOS
 * `BillingCycle.statementCutoff`). Cutoff 20 and due day 10 pay on Nov 10 what closed on Oct 20.
 */
export function statementCutoff(due: Date, cutoffDay: number): Date {
  const month = yearMonthContaining(due)
  const candidate = cutoffIn(month, cutoffDay)
  return candidate.getTime() < startOfDay(due).getTime() ? candidate : cutoffIn(addMonths(month, -1), cutoffDay)
}

/** The next date (today included) that falls on `day` of a month, clamped like cutoffs. */
export function nextOccurrence(day: number, onOrAfter: Date): Date {
  const today = startOfDay(onOrAfter)
  const month = yearMonthContaining(onOrAfter)
  const candidate = cutoffIn(month, day)
  return candidate.getTime() >= today.getTime() ? candidate : cutoffIn(addMonths(month, 1), day)
}

// Subscriptions: a charge in the "Subscriptions" category, or the same description in two months.

export const SUBSCRIPTIONS_CATEGORY_ID = "subscriptions"

/** Case- and accent-insensitive comparison key ("Café" = "cafe"). */
export function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

const isCharge = (transaction: Transaction) => transaction.kind === "expense" && isConfirmed(transaction)

/** "Apple Music" and "apple music " are the same service. */
const serviceKey = (description: string) => folded(description.trim())

/**
 * Of one card's charges, the folded descriptions that look like a service: in the Subscriptions
 * category, or charged in two different months.
 */
function serviceKeys(charges: readonly Transaction[]): Set<string> {
  const months = new Map<string, Set<string>>()
  const inCategory = new Set<string>()
  for (const transaction of charges) {
    const key = serviceKey(transaction.description)
    if (key === "") continue
    const set = months.get(key) ?? new Set<string>()
    set.add(monthKey(yearMonthContaining(dateOf(transaction))))
    months.set(key, set)
    if (transaction.categoryId === SUBSCRIPTIONS_CATEGORY_ID) inCategory.add(key)
  }
  return new Set([...months.entries()].filter(([key, set]) => inCategory.has(key) || set.size >= 2).map(([key]) => key))
}

/**
 * The services charged to a card: the heuristic over its movements, then the subscription rules paid
 * with it, each name once (folded).
 */
export function subscriptionsCharged(cardId: string, transactions: readonly Transaction[], rules: readonly RecurringRule[] = []): string[] {
  const charges = transactions.filter((transaction) => transaction.cardId === cardId && isCharge(transaction))
  const services = serviceKeys(charges)
  const latest = new Map<string, { date: number; description: string }>()
  for (const transaction of charges) {
    const key = serviceKey(transaction.description)
    if (!services.has(key)) continue
    const date = dateOf(transaction).getTime()
    const previous = latest.get(key)
    if (!previous || date > previous.date) latest.set(key, { date, description: transaction.description })
  }
  const charged = [...latest.entries()].sort(([, a], [, b]) => b.date - a.date)
  const names = new Set(charged.map(([key]) => key))
  const fromRules: string[] = []
  for (const rule of rules) {
    if (!rule.isSubscription || rule.cardId !== cardId) continue
    const key = serviceKey(rule.name)
    if (key === "" || names.has(key)) continue
    names.add(key)
    fromRules.push(rule.name.trim())
  }
  return [...charged.map(([, value]) => value.description), ...fromRules]
}

/** Newest first; the id breaks ties so the order never depends on how the list arrived. */
function newerFirst(a: Transaction, b: Transaction): number {
  const difference = dateOf(b).getTime() - dateOf(a).getTime()
  if (difference !== 0) return difference
  return a.id.toLowerCase() < b.id.toLowerCase() ? 1 : -1
}

/**
 * The charges of each service, newest first (iOS `Subscriptions.chargeHistories`): movements a rule
 * recorded grouped by that rule, and the rest grouped by card and description when
 * `subscriptionsCharged` would recognize them as a service. Planned movements don't count.
 */
export function chargeHistories(transactions: readonly Transaction[]): Transaction[][] {
  const groups = new Map<string, Transaction[]>()
  const byCard = new Map<string, Transaction[]>()
  const add = (map: Map<string, Transaction[]>, key: string, transaction: Transaction) => map.set(key, [...(map.get(key) ?? []), transaction])
  for (const transaction of transactions) {
    if (!isCharge(transaction)) continue
    if (transaction.recurringId) add(groups, `rule-${transaction.recurringId}`, transaction)
    else if (transaction.cardId) add(byCard, transaction.cardId, transaction)
  }
  for (const [cardId, charges] of byCard) {
    const services = serviceKeys(charges)
    for (const transaction of charges) {
      const key = serviceKey(transaction.description)
      if (services.has(key)) add(groups, `card-${cardId}-${key}`, transaction)
    }
  }
  return [...groups.values()].map((history) => [...history].sort(newerFirst))
}

/** How recent the newest charge must be for a price increase to still be worth mentioning. */
export const PRICE_INCREASE_RECENT_DAYS = 30

/** A subscription whose newest charge cost more than the one before it (iOS `PriceIncrease`). */
export interface PriceIncrease {
  /** The newest charge, so each increase is told once. */
  transactionId: string
  /** The newest charge's description. */
  name: string
  previous: Money
  current: Money
  date: Date
}

/**
 * Each service (`chargeHistories`) whose newest charge costs more than the one before it, in the
 * same currency, and happened within `PRICE_INCREASE_RECENT_DAYS` of `now`. Newest first.
 */
export function priceIncreases(transactions: readonly Transaction[], now: Date = new Date()): PriceIncrease[] {
  const since = addDays(startOfDay(now), -PRICE_INCREASE_RECENT_DAYS).getTime()
  const found: PriceIncrease[] = []
  for (const history of chargeHistories(transactions)) {
    const [newest, previous] = history
    if (!newest || !previous || newest.currency !== previous.currency) continue
    if (!dec(newest.amount).gt(dec(previous.amount)) || startOfDay(dateOf(newest)).getTime() < since) continue
    found.push({
      transactionId: newest.id,
      name: newest.description,
      previous: { amount: dec(previous.amount), currency: previous.currency },
      current: { amount: dec(newest.amount), currency: newest.currency },
      date: dateOf(newest),
    })
  }
  return found.sort((a, b) => b.date.getTime() - a.date.getTime() || (a.name < b.name ? -1 : 1))
}

// Scope: everything or one account (what left it and, for transfers, what arrived).

export type TransactionScope = { kind: "all" } | { kind: "account"; id: string }

export function scopeIncludes(scope: TransactionScope, transaction: Transaction): boolean {
  return scope.kind === "all" || transaction.accountId === scope.id || transaction.destinationAccountId === scope.id
}

// Card expiry: works through the last day of its month; reminder on the first of that month.

export function expiryReminderDay(expiry: { month: number; year: number }): Date {
  return new Date(expiry.year, expiry.month - 1, 1)
}

export function compareExpiry(a: { month: number; year: number }, b: { month: number; year: number }): number {
  return a.year === b.year ? a.month - b.month : a.year - b.year
}

/** Builds a valid "valid thru" or throws, like iOS `CardExpiry.init`. */
export function cardExpiry(month: number, year: number) {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2199) {
    throw DomainError.invalidExpiry()
  }
  return { month, year }
}

/** Last four digits: exactly four ASCII digits. */
export function checkLastFour(value: string | undefined): void {
  if (value !== undefined && !/^[0-9]{4}$/.test(value)) throw DomainError.invalidLastFour(value)
}

export function checkDayOfMonth(day: number | undefined): void {
  if (day !== undefined && (!Number.isInteger(day) || day < 1 || day > 31)) throw DomainError.invalidDayOfMonth(day)
}

/** "Bank One Savings": the bank followed by the account's own name. */
export function accountDisplayName(account: Pick<Account, "bank" | "name">): string {
  return [account.bank, account.name]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(" ")
}

export function cardsOf(accountId: string, cards: readonly Card[]): Card[] {
  return cards.filter((card) => card.accountId === accountId)
}

export { fromStored }
