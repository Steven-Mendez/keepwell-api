import type { RecurringRule, Transaction } from "../schema"

import { addDays, dayKey, startOfDay, zonedParts, type TimeZone } from "./calendar"
import { Decimal, ZERO, dec } from "./decimal"
import { DomainError } from "./errors"
import type { Money } from "./money"
import { MANUAL_PAYMENT_DAYS_BEFORE, MANUAL_PAYMENT_TOLERANCE, cycleEndingAt, isFinished } from "./recurring"
import { folded } from "./rules"
import type { LedgerStore } from "./store"

// Whether a recurring rule is paid, what it has been paid with and when it's next due: what the
// Recurring rows, the rule's detail and the MCP read. Port target: iOS `Domain/Rules/RecurringStatus.swift`.
// The shared cases are in `fixtures/recurring-status.json`.

/**
 * - `overdue`: a draft the rule left waits from before today.
 * - `toConfirm`: a draft the rule left waits from today.
 * - `paused` / `ended`: it produces nothing.
 * - `paid`: the cycle that ends at its next date has a confirmed payment.
 * - `upcoming`: nothing to do until its next date.
 */
export type RuleState = "overdue" | "toConfirm" | "paused" | "ended" | "paid" | "upcoming"

export interface RuleStatus {
  state: RuleState
  /** The next occurrence the rule will produce; none once it ended. */
  nextDate?: Date
  /** Calendar days from today to `nextDate`: 0 today, negative when it's behind. */
  daysUntilNext?: number
  /** The oldest draft of the rule dated today or before, for `overdue` and `toConfirm`. */
  draft?: Transaction
  /** Calendar days from the draft's day to today. */
  daysOverdue: number
  /** The confirmed payment of the current cycle, when there is one. */
  payment?: Transaction
  /** The latest confirmed payment linked to the rule, in any cycle. */
  lastPayment?: Transaction
  /** The occurrence the current cycle pays: the one before `nextDate`. */
  cycleDate: Date
}

const DAY_MS = 86_400_000

const daysBetween = (from: Date, to: Date, zone: TimeZone) => Math.round((startOfDay(to, zone).getTime() - startOfDay(from, zone).getTime()) / DAY_MS)

/** Latest first, then the lowest id, so every platform lists them alike. */
const latestFirst = (a: Transaction, b: Transaction) => new Date(b.date).getTime() - new Date(a.date).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The movements linked to the rule, latest first. */
export function rulePayments(rule: Pick<RecurringRule, "id">, transactions: readonly Transaction[]): Transaction[] {
  return transactions.filter((transaction) => transaction.recurringId === rule.id).sort(latestFirst)
}

/**
 * The confirmed movement of the rule that pays a cycle: dated from two calendar days before the
 * cycle's occurrence (a manual payment may come early, as in `manualPaymentFor`) up to two days
 * before the next one. The latest one when there are several.
 */
export function cyclePayment(rule: Pick<RecurringRule, "id">, cycle: { start: Date; end: Date }, transactions: readonly Transaction[], zone: TimeZone): Transaction | undefined {
  const first = dayKey(addDays(cycle.start, -MANUAL_PAYMENT_DAYS_BEFORE, zone), zone)
  const end = dayKey(addDays(cycle.end, -MANUAL_PAYMENT_DAYS_BEFORE, zone), zone)
  return rulePayments(rule, transactions).find((transaction) => {
    if (transaction.status !== "confirmed") return false
    const day = dayKey(new Date(transaction.date), zone)
    return day >= first && day < end
  })
}

/** Whether the rule is paid, has something waiting, and when it's next due. */
export function ruleStatus(rule: RecurringRule, transactions: readonly Transaction[], today: Date, zone: TimeZone): RuleStatus {
  const linked = rulePayments(rule, transactions)
  const todayKey = dayKey(today, zone)
  const next = new Date(rule.nextDate)
  const finished = isFinished(rule, zone)
  const cycle = cycleEndingAt(rule, next, zone)
  const lastPayment = linked.find((transaction) => transaction.status === "confirmed")
  const payment = cyclePayment(rule, cycle, transactions, zone)
  // The oldest draft dated today or before: the one most overdue.
  const draft = linked.filter((transaction) => transaction.status === "planned" && dayKey(new Date(transaction.date), zone) <= todayKey).at(-1)
  const daysOverdue = draft ? Math.max(0, daysBetween(new Date(draft.date), today, zone)) : 0
  const state: RuleState = draft ? (daysOverdue > 0 ? "overdue" : "toConfirm") : rule.isPaused ? "paused" : finished ? "ended" : payment ? "paid" : "upcoming"
  return {
    state,
    ...(finished ? {} : { nextDate: next, daysUntilNext: daysBetween(today, next, zone) }),
    ...(draft ? { draft } : {}),
    daysOverdue,
    ...(payment ? { payment } : {}),
    ...(lastPayment ? { lastPayment } : {}),
    cycleDate: cycle.start,
  }
}

export interface RulePriceChange {
  from: Money
  to: Money
  /** The first payment at the new amount. */
  transaction: Transaction
}

export interface RuleHistory {
  /** Every movement linked to the rule, drafts included, latest first. */
  payments: Transaction[]
  /** How many of them are confirmed. */
  paidCount: number
  /** Confirmed payments of today's calendar year in the rule's currency. */
  paidThisYear: Money
  /** Set when the latest confirmed payment's amount differs from the one before it. */
  priceChange?: RulePriceChange
}

/** What the rule has been paid with: its detail's list and the figures above it. */
export function ruleHistory(rule: RecurringRule, transactions: readonly Transaction[], today: Date, zone: TimeZone): RuleHistory {
  const payments = rulePayments(rule, transactions)
  const confirmed = payments.filter((transaction) => transaction.status === "confirmed" && transaction.currency === rule.currency)
  const year = zonedParts(today, zone).year
  const paidThisYear = confirmed.reduce((sum, transaction) => (zonedParts(new Date(transaction.date), zone).year === year ? sum.plus(dec(transaction.amount)) : sum), ZERO)
  const [latest, before] = confirmed
  const changed = latest && before && !dec(latest.amount).equals(dec(before.amount))
  return {
    payments,
    paidCount: payments.filter((transaction) => transaction.status === "confirmed").length,
    paidThisYear: { amount: paidThisYear, currency: rule.currency },
    ...(changed ? { priceChange: { from: { amount: dec(before.amount), currency: rule.currency }, to: { amount: dec(latest.amount), currency: rule.currency }, transaction: latest } } : {}),
  }
}

/** How far a candidate's amount may be from the rule's to be suggested without a matching name. */
const withinTolerance = (amount: Decimal, ruleAmount: Decimal) => amount.minus(ruleAmount).abs().lessThanOrEqualTo(ruleAmount.abs().times(MANUAL_PAYMENT_TOLERANCE))

/**
 * Movements worth offering under "Link a payment": confirmed, linked to no rule, of the rule's kind
 * and currency (and destination, for a transfer), whose amount is within 7.5 % of the rule's or
 * whose description names the rule (either contains the other). Any account or card: a subscription
 * is sometimes paid with another one. Likeliest first: the ones that name the rule, then the closest
 * amount, then the latest, so "Grok $15" comes before a $15.82 dinner the same week.
 */
export function paymentCandidates(rule: RecurringRule, transactions: readonly Transaction[]): Transaction[] {
  const name = folded(rule.name.trim())
  const ruleAmount = dec(rule.amount)
  const names = (transaction: Transaction) => {
    const description = folded(transaction.description.trim())
    return name !== "" && description !== "" && (description.includes(name) || name.includes(description))
  }
  const distance = (transaction: Transaction) => dec(transaction.amount).minus(ruleAmount).abs()
  return transactions
    .filter((transaction) => {
      if (transaction.recurringId !== undefined || transaction.status !== "confirmed") return false
      if (transaction.kind !== rule.kind || transaction.currency !== rule.currency) return false
      if (rule.kind === "transfer" && transaction.destinationAccountId !== rule.destinationAccountId) return false
      return names(transaction) || withinTolerance(dec(transaction.amount), ruleAmount)
    })
    .sort((a, b) => Number(names(b)) - Number(names(a)) || distance(a).comparedTo(distance(b)) || latestFirst(a, b))
}

/** Whether a movement can be linked to the rule by hand: same kind, and not another rule's. */
export function canLinkPayment(rule: RecurringRule, transaction: Transaction): boolean {
  return transaction.kind === rule.kind && (transaction.recurringId === undefined || transaction.recurringId === rule.id)
}

/**
 * Links a movement to a rule as one of its payments. The rule's schedule doesn't move: linking says
 * what paid it, it doesn't produce or skip an occurrence.
 */
export async function linkPayment(store: LedgerStore, ruleId: string, transactionId: string): Promise<Transaction> {
  return store.atomically(async () => {
    const rule = (await store.fetchRecurringRules()).find((candidate) => candidate.id === ruleId)
    if (!rule) throw DomainError.notFound(ruleId)
    const transaction = (await store.fetchTransactions()).find((candidate) => candidate.id === transactionId)
    if (!transaction) throw DomainError.notFound(transactionId)
    if (transaction.kind !== rule.kind) throw DomainError.unsupportedTransactionKind(transaction.kind)
    if (transaction.recurringId === rule.id) return transaction
    const linked = { ...transaction, recurringId: rule.id }
    await store.saveTransaction(linked)
    return linked
  })
}

/** Takes a movement out of its rule's payments; the movement itself stays as it is. */
export async function unlinkPayment(store: LedgerStore, transactionId: string): Promise<Transaction> {
  return store.atomically(async () => {
    const transaction = (await store.fetchTransactions()).find((candidate) => candidate.id === transactionId)
    if (!transaction) throw DomainError.notFound(transactionId)
    if (transaction.recurringId === undefined) return transaction
    const { recurringId: _rule, ...unlinked } = transaction
    await store.saveTransaction(unlinked)
    return unlinked
  })
}

export interface RecurringMonthProgress {
  /** Active expense rules with an occurrence in today's calendar month. */
  total: number
  /** Of those, the ones whose occurrence this month is paid. */
  paid: number
  /** What's left to pay this month, one amount per currency (never summed across), by code. */
  remaining: Money[]
}

/**
 * "3 of 8 paid this month": the active expense rules due in today's calendar month and how many are
 * paid. A rule counts when its next date is in the month (not paid yet), or when the occurrence
 * before it is and it is either paid or left a draft waiting. A past occurrence with neither is not
 * counted as owed: the rule may have been set up after it, and nothing ever asked for it.
 */
export function recurringMonthProgress(rules: readonly RecurringRule[], transactions: readonly Transaction[], today: Date, zone: TimeZone): RecurringMonthProgress {
  const month = dayKey(today, zone).slice(0, 7)
  const inMonth = (date: Date) => dayKey(date, zone).slice(0, 7) === month
  const remaining = new Map<string, Decimal>()
  let total = 0
  let paid = 0
  for (const rule of rules) {
    if (rule.kind !== "expense" || rule.isPaused || isFinished(rule, zone)) continue
    const status = ruleStatus(rule, transactions, today, zone)
    const owes = () => remaining.set(rule.currency, (remaining.get(rule.currency) ?? ZERO).plus(dec(rule.amount)))
    if (status.nextDate && inMonth(status.nextDate)) {
      total++
      owes()
    } else if (inMonth(status.cycleDate)) {
      if (status.state === "paid") {
        total++
        paid++
      } else if (status.draft) {
        total++
        owes()
      }
    }
  }
  return {
    total,
    paid,
    remaining: [...remaining].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, amount]) => ({ amount, currency })),
  }
}
