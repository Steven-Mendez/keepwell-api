import type { Account, CurrencySettings, RecurringRule, Transaction } from "../schema"

import { addDays, addMonths, daysInMonth, monthInterval, startOfDay, yearMonthContaining, type YearMonth } from "./calendar"
import { Decimal, ZERO, dec, sum } from "./decimal"
import { convert, settingsRate } from "./money"
import { pendingOccurrences } from "./recurring"
import { balanceOf, direction, isConfirmed, monthlyTotals, nextOccurrence, share, statementCutoff } from "./rules"

// Port of iOS Domain/Rules/BalanceForecast.swift and CardStatement.swift: "at the end of the month
// you'll have about C$X", computed line by line the same on both platforms.

/** At today's settings rate; a currency the settings no longer convert counts as nothing. */
function principalOf(amount: Decimal, currency: string, settings: CurrencySettings): Decimal {
  try {
    return convert({ amount, currency }, settingsRate(settings), settings.principal).amount
  } catch {
    return ZERO
  }
}

/**
 * What a credit card's next payment asks for, in the principal currency, never below zero (iOS
 * `CardStatement.amountDue`). With a cutoff day it's the debt through the last cutoff before `due`,
 * less payments and refunds that reached the card after it; without one, the whole debt today.
 */
export function cardAmountDue(due: Date, account: Account, transactions: readonly Transaction[], settings: CurrencySettings): Decimal {
  const principal = (amount: Decimal, currency: string) => principalOf(amount, currency, settings)
  const cutoffDay = account.creditTerms?.cutoffDay
  if (cutoffDay === undefined) {
    const debt = sum(balanceOf(account, transactions).map((balance) => principal(balance.amount, balance.currency)))
    return Decimal.max(debt.neg(), ZERO)
  }
  const closed = addDays(statementCutoff(due, cutoffDay), 1).getTime()
  const statement = balanceOf(
    account,
    transactions.filter((transaction) => new Date(transaction.date).getTime() < closed),
  )
  const owed = sum(statement.map((balance) => principal(balance.amount, balance.currency))).neg()
  let paid = ZERO
  for (const transaction of transactions) {
    if (!isConfirmed(transaction) || new Date(transaction.date).getTime() < closed || direction(transaction, account.id) <= 0) continue
    const { currency, amount } = share(transaction, account)
    paid = paid.plus(principal(amount, currency))
  }
  return Decimal.max(owed.minus(paid), ZERO)
}

/** How many complete months before the current one the usual spending averages. */
export const USUAL_SPENDING_MONTHS = 3

/** The month-end estimate and the lines that add up to it, all in `currency` (iOS `BalanceForecast`). */
export interface BalanceForecast {
  currency: string
  /** Balances of deposit and cash accounts today, at the settings rate. */
  availableToday: Decimal
  /** Drafts from today through month end on bank and cash accounts. */
  draftIncome: Decimal
  draftExpenses: Decimal
  /** Occurrences of active rules not recorded yet, through month end, paid from bank or cash. */
  recurringIncome: Decimal
  recurringExpenses: Decimal
  /** What credit cards due this month ask for (`cardAmountDue`). */
  cardPayments: Decimal
  /** The average monthly day-to-day spending, for the days left after today. */
  usualSpending: Decimal
}

export const forecastPlannedIncome = (forecast: BalanceForecast) => forecast.draftIncome.plus(forecast.recurringIncome)
export const forecastPlannedExpenses = (forecast: BalanceForecast) => forecast.draftExpenses.plus(forecast.recurringExpenses)

export function forecastTotal(forecast: BalanceForecast): Decimal {
  return forecast.availableToday
    .plus(forecastPlannedIncome(forecast))
    .minus(forecastPlannedExpenses(forecast))
    .minus(forecast.cardPayments)
    .minus(forecast.usualSpending)
}

/**
 * Average confirmed spending of the complete months before `month` that had any, so a month before
 * the person started doesn't drag it down. Zero without any.
 */
export function averageUsualSpending(transactions: readonly Transaction[], month: YearMonth): Decimal {
  const totals = monthlyTotals("expense", addMonths(month, -1), USUAL_SPENDING_MONTHS, transactions)
    .map((entry) => entry.total)
    .filter((total) => total.gt(0))
  return totals.length === 0 ? ZERO : sum(totals).div(totals.length)
}

/**
 * - Second-currency amounts convert at today's settings rate, as net worth does; past spending keeps
 *   each movement's own principal amount, as the summary does.
 * - Transfers move money between the person's accounts and are left out; card purchases are paid
 *   through `cardPayments` instead of on their own.
 * - Usual spending averages confirmed expenses on bank and cash accounts not recorded by a rule (rules
 *   are already counted) over the last `USUAL_SPENDING_MONTHS` complete months that had any, times
 *   the days after today over the days in the month.
 */
export function balanceForecast(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  rules: readonly RecurringRule[],
  settings: CurrencySettings,
  now: Date = new Date(),
): BalanceForecast {
  const principal = (amount: Decimal, currency: string) => principalOf(amount, currency, settings)
  const kinds = new Map(accounts.map((account) => [account.id, account.kind]))
  const isSpendable = (accountId: string) => {
    const kind = kinds.get(accountId)
    return kind !== undefined && kind !== "credit"
  }
  const today = startOfDay(now).getTime()
  const month = yearMonthContaining(now)
  const end = monthInterval(month).end
  const lastDay = addDays(end, -1)
  const days = daysInMonth(month)
  const daysLeft = days - now.getDate()

  const availableToday = sum(
    accounts
      .filter((account) => account.kind !== "credit")
      .flatMap((account) => balanceOf(account, transactions))
      .map((balance) => principal(balance.amount, balance.currency)),
  )

  let draftIncome = ZERO
  let draftExpenses = ZERO
  for (const transaction of transactions) {
    const time = new Date(transaction.date).getTime()
    if (isConfirmed(transaction) || time < today || time >= end.getTime() || !isSpendable(transaction.accountId)) continue
    const amount = principal(dec(transaction.amount), transaction.currency)
    if (transaction.kind === "income") draftIncome = draftIncome.plus(amount)
    else if (transaction.kind === "expense") draftExpenses = draftExpenses.plus(amount)
  }

  let recurringIncome = ZERO
  let recurringExpenses = ZERO
  for (const rule of rules) {
    if (rule.kind === "transfer" || !isSpendable(rule.accountId)) continue
    const amount = principal(dec(rule.amount), rule.currency).times(pendingOccurrences(rule, lastDay).length)
    if (rule.kind === "income") recurringIncome = recurringIncome.plus(amount)
    else recurringExpenses = recurringExpenses.plus(amount)
  }

  let cardPayments = ZERO
  for (const account of accounts) {
    const dueDay = account.creditTerms?.dueDay
    if (account.kind !== "credit" || dueDay === undefined) continue
    const due = nextOccurrence(dueDay, now)
    if (due.getTime() >= end.getTime()) continue
    cardPayments = cardPayments.plus(cardAmountDue(due, account, transactions, settings))
  }

  const average = averageUsualSpending(
    transactions.filter((transaction) => transaction.recurringId === undefined && isSpendable(transaction.accountId)),
    month,
  )

  return {
    currency: settings.principal,
    availableToday,
    draftIncome,
    draftExpenses,
    recurringIncome,
    recurringExpenses,
    cardPayments,
    usualSpending: average.times(daysLeft).div(days),
  }
}
