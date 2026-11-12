import type { DebtDirection, RecurringRule, Transaction } from "../schema"

import { addDays, dayKey, startOfDay, type TimeZone } from "./calendar"
import { loanProgress } from "./debts"
import { cardAmountDue } from "./forecast"
import { fromStored, type Money } from "./money"
import type { Ledger } from "./overviews"
import { upcoming } from "./recurring"
import { isConfirmed, nextOccurrence } from "./rules"

// "What do I have pending in the next N days": one list that Home (web and iOS), the Recurring rows,
// the line under Home's greeting and the MCP tool all read, so none of them contradicts another.
// Port target: iOS `Domain/Rules/UpcomingPayments.swift`. The shared cases are in
// `fixtures/upcoming.json`.

/** Overdue: its day is before today. Today: it's today's. Upcoming: a later day in the window. */
export type PaymentStatus = "overdue" | "today" | "upcoming"

interface Base {
  /** Stable and the same on every platform; the kind and what it points at, see each kind. */
  id: string
  date: Date
  status: PaymentStatus
  /** Calendar days from today to its day: negative when overdue. */
  daysFromToday: number
}

export type UpcomingPayment = Base &
  (
    | /** A movement waiting to be confirmed, from a rule or not. Id `draft:<transactionId>`. */
    { kind: "draft"; transaction: Transaction; amount: Money }
    | /** An occurrence a rule hasn't produced yet. Id `recurring:<ruleId>:<yyyy-mm-dd>`. */
    { kind: "recurring"; rule: RecurringRule; amount: Money }
    | /** A credit card's next payment, in the principal currency. Id `card:<accountId>:<yyyy-mm-dd>`. */
    { kind: "card"; accountId: string; dueDay: number; amount: Money }
    | /** An unpaid loan installment, in the loan's currency. Id `installment:<loanId>:<number>`. */
    { kind: "installment"; loanId: string; number: number; count: number; amount: Money }
    | /**
     * A personal debt with a due date, what's left of it in its currency. Id `debt:<debtId>`.
     * Produced once personal debts have a due date (T24); every reader already handles it.
     */
    { kind: "debt"; debtId: string; person: string; direction: DebtDirection; amount: Money }
  )

export type UpcomingPaymentKind = UpcomingPayment["kind"]

/** Within one day: what needs the person first (drafts, installments, cards), then the rest. */
export const UPCOMING_KIND_ORDER: readonly UpcomingPaymentKind[] = ["draft", "installment", "card", "recurring", "debt"]

const DAY_MS = 86_400_000

/** Byte order, never `localeCompare`: the same on every platform (ids are ASCII). */
const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Everything pending from any past day through `days` calendar days after today (in the ledger's
 * zone), overdue first from the oldest, then by day; within a day by kind (`UPCOMING_KIND_ORDER`)
 * and then by id.
 *
 * - drafts (`planned` movements) dated up to the last day, however old: overdue before today;
 * - recurring occurrences not produced yet (`upcoming`), never overdue; paused and ended rules
 *   have none. Income and transfers too: the reader filters by `rule.kind`;
 * - credit card payments due by the last day (`nextOccurrence`, never overdue: without a payment
 *   linked to the statement a late one can't be told from one recorded late), only when
 *   `cardAmountDue` asks for something;
 * - unpaid loan installments due by the last day, the past ones too (overdue).
 *
 * Amounts stay in their own currency and are never added up; a card's is in the principal
 * currency, as `cardAmountDue` converts it.
 */
export function upcomingPayments(ledger: Ledger, now: Date, days: number): UpcomingPayment[] {
  const zone = ledger.timeZone
  const today = startOfDay(now, zone)
  const last = addDays(today, days, zone)
  const found: UpcomingPayment[] = []
  const at = (date: Date): Omit<Base, "id"> => {
    const daysFromToday = daysBetween(today, date, zone)
    return { date, daysFromToday, status: daysFromToday < 0 ? "overdue" : daysFromToday === 0 ? "today" : "upcoming" }
  }
  const lastTime = last.getTime()
  const inWindow = (date: Date) => startOfDay(date, zone).getTime() <= lastTime

  for (const transaction of ledger.transactions) {
    if (isConfirmed(transaction)) continue
    const date = new Date(transaction.date)
    if (!inWindow(date)) continue
    found.push({
      ...at(date),
      id: `draft:${transaction.id}`,
      kind: "draft",
      transaction,
      amount: fromStored({ amount: transaction.amount, currency: transaction.currency }),
    })
  }

  for (const { rule, date } of upcoming(ledger.recurringRules, now, days, zone)) {
    found.push({
      ...at(date),
      id: `recurring:${rule.id}:${dayKey(date, zone)}`,
      kind: "recurring",
      rule,
      amount: fromStored({ amount: rule.amount, currency: rule.currency }),
    })
  }

  const settings = ledger.settings.currencies
  for (const account of ledger.accounts) {
    const dueDay = account.creditTerms?.dueDay
    if (account.kind !== "credit" || !dueDay) continue
    const due = nextOccurrence(dueDay, now, zone)
    if (!inWindow(due)) continue
    const owed = cardAmountDue(due, account, ledger.transactions, settings, zone)
    // Nothing to pay is nothing pending; the payment reminder still says the day has come.
    if (owed.isZero()) continue
    found.push({
      ...at(due),
      id: `card:${account.id}:${dayKey(due, zone)}`,
      kind: "card",
      accountId: account.id,
      dueDay,
      amount: { amount: owed, currency: settings.principal },
    })
  }

  for (const loan of ledger.loans) {
    const amount = fromStored({ amount: loan.installmentAmount, currency: loan.borrowed.currency })
    for (const installment of loanProgress(loan, now, zone).installments) {
      if (installment.payment || installment.number > loan.installmentCount) continue
      if (!inWindow(installment.dueDate)) break
      found.push({
        ...at(installment.dueDate),
        id: `installment:${loan.id}:${installment.number}`,
        kind: "installment",
        loanId: loan.id,
        number: installment.number,
        count: loan.installmentCount,
        amount,
      })
    }
  }

  return found.sort(compareUpcomingPayments)
}

/** The order `upcomingPayments` returns: by day, then kind, then id. */
export function compareUpcomingPayments(a: UpcomingPayment, b: UpcomingPayment): number {
  return a.daysFromToday - b.daysFromToday || UPCOMING_KIND_ORDER.indexOf(a.kind) - UPCOMING_KIND_ORDER.indexOf(b.kind) || byBytes(a.id, b.id)
}

/** Rounded: a day across a daylight-saving change is 23 or 25 hours long. */
function daysBetween(from: Date, to: Date, zone: TimeZone): number {
  return Math.round((startOfDay(to, zone).getTime() - startOfDay(from, zone).getTime()) / DAY_MS)
}

export interface PendingRuleDraft {
  /** The draft the rule left waiting, dated today or before. */
  transaction: Transaction
  /** Calendar days from its date to today: 0 when it's today's. */
  daysOverdue: number
}

/**
 * The draft each rule left waiting to be confirmed, by rule id: of its drafts dated today or
 * earlier, the oldest, since that's the one most overdue. A draft for a later day isn't due yet.
 * The Recurring row shows it in place of the next date. Pass `upcomingPayments(ledger, now, 0)`.
 */
export function pendingRuleDrafts(payments: readonly UpcomingPayment[]): Map<string, PendingRuleDraft> {
  const pending = new Map<string, PendingRuleDraft>()
  for (const payment of payments) {
    if (payment.kind !== "draft" || payment.status === "upcoming") continue
    const { transaction } = payment
    const ruleId = transaction.recurringId
    if (!ruleId) continue
    const current = pending.get(ruleId)?.transaction
    const time = new Date(transaction.date).getTime()
    if (current) {
      const currentTime = new Date(current.date).getTime()
      if (currentTime < time || (currentTime === time && current.id < transaction.id)) continue
    }
    pending.set(ruleId, { transaction, daysOverdue: Math.max(0, -payment.daysFromToday) })
  }
  return pending
}
