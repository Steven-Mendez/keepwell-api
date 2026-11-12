import { budgetStatuses, type BudgetLevel } from "./budgets"
import { addDays, compareMonths, dayKey, monthKey, startOfDay, yearMonthContaining } from "./calendar"
import type { Decimal } from "./decimal"
import { orderedLoans } from "./debts"
import { fromStored, type Money } from "./money"
import { homeOverview, type Ledger } from "./overviews"
import { upcoming } from "./recurring"
import { monthlySummary, nextOccurrence } from "./rules"

// The notifications (ADR 0012 in keepwell-api): what the ledger says needs attention on a given day.
// They are derived, never stored; what is stored is the person's state for each one
// (`NotificationState`: read, deleted), keyed by `id`. That only works because an id names one
// occurrence and is the same on the web, on iOS and on the server, so its format is part of the
// contract: change it and every read or deleted notification comes back.
//
// Days in ids are the device's (or, on the server, the person's) calendar days, `yyyy-mm-dd`.

export type NotificationKind = "planned" | "payment" | "cutoff" | "installment" | "renewal" | "bill" | "expiry" | "budget" | "price" | "proposal"

/** Where tapping a notification leads; each app maps it to its own screen. */
export type NotificationTarget =
  | { screen: "transaction"; id: string }
  | { screen: "creditCard"; accountId: string }
  | { screen: "account"; accountId: string }
  | { screen: "debts" }
  | { screen: "recurring" }
  | { screen: "summary" }

interface Base<K extends NotificationKind, P> {
  id: string
  kind: K
  /** Start of the day it starts to apply: groups the inbox and is when the server sends it. */
  date: Date
  params: P
  target: NotificationTarget
}

export type LedgerNotification =
  | Base<"planned", { transactionId: string; description: string; amount: Money; accountId: string; cardId?: string | undefined }>
  | Base<"payment", { accountId: string; dueDay: number; dueDate: Date; daysLeft: number }>
  | Base<"cutoff", { accountId: string }>
  | Base<"installment", { loanId: string; name: string; number: number; count: number; amount: Money; daysLeft: number }>
  | Base<"renewal", { ruleId: string; name: string; amount: Money; accountId: string; cardId?: string | undefined }>
  | Base<"bill", { ruleId: string; name: string; amount: Money; accountId: string; cardId?: string | undefined }>
  | Base<"expiry", { cardId: string; services: string[] }>
  | Base<"budget", { categoryId: string; level: Exclude<BudgetLevel, "onTrack">; spent: Decimal; budget: Decimal; currency: string }>
  | Base<"price", { transactionId: string; name: string; previous: Money; current: Money }>
  | Base<"proposal", { ruleId: string; name: string; amount: Money }>

const DAY_MS = 86_400_000
const daysBetween = (from: Date, to: Date) => Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS)

/**
 * Everything that applies on the day of `now`, newest first:
 *
 * - drafts dated today or before (`planned`),
 * - card payments from `paymentReminderDaysBefore` days ahead until the due day,
 * - statements closing today, loan installments inside the same window as card payments,
 * - subscriptions renewing tomorrow, and other recurring expenses due tomorrow that are recorded as
 *   drafts (`bill`; one recorded on its own needs nothing from the person), plastics expiring this month,
 * - budgets from 80% of the month's limit (a second notification once spent),
 * - subscriptions whose latest charge cost more than the one before,
 * - recurring payments an assistant proposed, paused until confirmed (ADR 0007).
 */
export function ledgerNotifications(ledger: Ledger, now: Date): LedgerNotification[] {
  const overview = homeOverview(ledger, now)
  const today = startOfDay(now)
  const window = overview.paymentReminderDaysBefore
  const found: LedgerNotification[] = []

  for (const transaction of overview.planned) {
    const date = startOfDay(new Date(transaction.date))
    if (date.getTime() > today.getTime()) continue
    found.push({
      id: `planned:${transaction.id}`,
      kind: "planned",
      date,
      params: {
        transactionId: transaction.id,
        description: transaction.description,
        amount: fromStored({ amount: transaction.amount, currency: transaction.currency }),
        accountId: transaction.accountId,
        cardId: transaction.cardId,
      },
      target: { screen: "transaction", id: transaction.id },
    })
  }

  for (const account of ledger.accounts) {
    if (account.kind !== "credit") continue
    const dueDay = account.creditTerms?.dueDay
    if (dueDay) {
      const due = nextOccurrence(dueDay, now)
      const daysLeft = daysBetween(today, due)
      if (daysLeft <= window) {
        found.push({
          id: `payment:${account.id}:${dayKey(due)}`,
          kind: "payment",
          date: addDays(due, -window),
          params: { accountId: account.id, dueDay, dueDate: due, daysLeft },
          target: { screen: "creditCard", accountId: account.id },
        })
      }
    }
    const cutoffDay = account.creditTerms?.cutoffDay
    if (cutoffDay && nextOccurrence(cutoffDay, now).getTime() === today.getTime()) {
      found.push({
        id: `cutoff:${account.id}:${dayKey(today)}`,
        kind: "cutoff",
        date: today,
        params: { accountId: account.id },
        target: { screen: "creditCard", accountId: account.id },
      })
    }
  }

  for (const progress of orderedLoans(ledger.loans, now)) {
    const next = progress.next
    if (!next) continue
    const daysLeft = daysBetween(today, next.dueDate)
    // An overdue installment is Debts' to show, not a reminder's.
    if (daysLeft < 0 || daysLeft > window) continue
    const { loan } = progress
    found.push({
      id: `installment:${loan.id}:${next.number}`,
      kind: "installment",
      date: addDays(startOfDay(next.dueDate), -window),
      params: {
        loanId: loan.id,
        name: loan.name,
        number: next.number,
        count: loan.installmentCount,
        amount: fromStored({ amount: loan.installmentAmount, currency: loan.borrowed.currency }),
        daysLeft,
      },
      target: { screen: "debts" },
    })
  }

  const tomorrow = addDays(today, 1).getTime()
  for (const { rule, date } of upcoming(ledger.recurringRules, now, 1)) {
    if (startOfDay(date).getTime() !== tomorrow) continue
    const params = { ruleId: rule.id, name: rule.name, amount: fromStored({ amount: rule.amount, currency: rule.currency }), accountId: rule.accountId, cardId: rule.cardId }
    if (rule.isSubscription) {
      found.push({ id: `renewal:${rule.id}:${dayKey(date)}`, kind: "renewal", date: today, params, target: { screen: "recurring" } })
    } else if (rule.kind === "expense" && !rule.autoConfirm) {
      // A bill (rent, school, a loan from family) is recorded as a draft the person has to pay and
      // confirm, so the day before is when a reminder helps. Its target is one every app already
      // knows: an installed app that predates this kind still opens a pushed one (ADR 0012).
      found.push({ id: `bill:${rule.id}:${dayKey(date)}`, kind: "bill", date: today, params, target: { screen: "recurring" } })
    }
  }

  const thisMonth = yearMonthContaining(now)
  for (const card of ledger.cards) {
    if (!card.expiry || compareMonths(card.expiry, thisMonth) !== 0) continue
    found.push({
      id: `expiry:${card.id}:${monthKey(thisMonth)}`,
      kind: "expiry",
      date: new Date(thisMonth.year, thisMonth.month - 1, 1),
      params: { cardId: card.id, services: overview.cardSubscriptions.get(card.id) ?? [] },
      target: { screen: "account", accountId: card.accountId },
    })
  }

  found.push(...budgetNotifications(ledger, now))

  for (const increase of overview.priceIncreases) {
    found.push({
      id: `price:${increase.transactionId}`,
      kind: "price",
      date: startOfDay(increase.date),
      params: { transactionId: increase.transactionId, name: increase.name.trim(), previous: increase.previous, current: increase.current },
      target: { screen: "recurring" },
    })
  }

  for (const rule of ledger.recurringRules) {
    if (rule.source !== "mcp" || !rule.isPaused) continue
    found.push({
      id: `proposal:${rule.id}`,
      kind: "proposal",
      date: startOfDay(new Date(rule.startDate)),
      params: { ruleId: rule.id, name: rule.name, amount: fromStored({ amount: rule.amount, currency: rule.currency }) },
      target: { screen: "recurring" },
    })
  }

  return found.sort((a, b) => b.date.getTime() - a.date.getTime())
}

/**
 * One per budgeted category past 80% this month, and its level is in the id: going over after
 * being close is a new notification, even if the "close" one was deleted. It's dated the day of the
 * latest spending in the category, the closest the ledger knows to when the line was crossed.
 */
function budgetNotifications(ledger: Ledger, now: Date): LedgerNotification[] {
  const month = yearMonthContaining(now)
  const currency = ledger.settings.currencies.principal
  const summary = monthlySummary(month, ledger.transactions, currency)
  return budgetStatuses(summary, ledger.categories).flatMap((status): LedgerNotification[] => {
    if (status.level === "onTrack") return []
    const level = status.level
    const latest = ledger.transactions.find(
      (transaction) =>
        transaction.categoryId === status.categoryId &&
        transaction.kind === "expense" &&
        compareMonths(yearMonthContaining(new Date(transaction.date)), month) === 0 &&
        new Date(transaction.date).getTime() <= now.getTime(),
    )
    return [
      {
        id: `budget:${status.categoryId}:${monthKey(month)}:${level === "exceeded" ? "over" : "near"}`,
        kind: "budget",
        date: startOfDay(latest ? new Date(latest.date) : now),
        params: { categoryId: status.categoryId, level, spent: status.spent, budget: status.budget, currency },
        target: { screen: "summary" },
      },
    ]
  })
}

/**
 * A notification id's day, for pruning state rows nobody will see again. `undefined` for ids that
 * carry no day (installments, price increases, drafts, proposals): those are pruned once the thing
 * they point at is gone, by whoever owns that rule.
 */
export function notificationDay(id: string): Date | undefined {
  const match = /:(\d{4})-(\d{2})(?:-(\d{2}))?(?::|$)/.exec(id)
  if (!match) return undefined
  return new Date(Number(match[1]), Number(match[2]) - 1, match[3] ? Number(match[3]) : 1)
}

/** Days after its day that a notification's state is kept before a client tombstones it. */
export const NOTIFICATION_STATE_RETENTION_DAYS = 90
