import type { Account, CurrencySettings, Transaction } from "../schema"

import { addDays, addMonths, compareMonths, monthInterval, sameMonth, startOfDay, yearMonthContaining, type TimeZone, type YearMonth } from "./calendar"
import type { Decimal } from "./decimal"
import type { Money } from "./money"
import { balanceOf, isConfirmed, netWorth } from "./rules"

// Port of iOS Domain/Rules/NetWorthHistory.swift: net worth at the end of each of the last months,
// computed the same on both platforms over the same shared fixture.

/** The current month and the eleven before it. */
export const NET_WORTH_HISTORY_MONTHS = 12

export interface NetWorthPoint {
  month: YearMonth
  /** In the principal currency; credit debts count negative, as in today's net worth. */
  total: Money
}

/**
 * Oldest first.
 * - Each past month is valued at its last moment; the current one as of the end of today, so
 *   movements dated later this month are not counted yet.
 * - An account adds its balance (`balanceOf`, confirmed movements dated up to then) only once its
 *   opening day has come; before that it contributes nothing.
 * - Each month converts at the rate it had then: the one stored by the latest confirmed movement
 *   dated before its cutoff whose rate is between today's principal and second currencies
 *   (`rateBefore`). Without such a movement it falls back to today's settings rate, which is also
 *   what months in a single currency use.
 * - Months before the first account opened are left out; without accounts there are none.
 */
export function netWorthHistory(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  settings: CurrencySettings,
  zone: TimeZone,
  now: Date = new Date(),
  count = NET_WORTH_HISTORY_MONTHS,
): NetWorthPoint[] {
  if (accounts.length === 0) return []
  const firstOpening = Math.min(...accounts.map((account) => new Date(account.openingDate).getTime()))
  const first = yearMonthContaining(new Date(firstOpening), zone)
  const current = yearMonthContaining(now, zone)
  const endOfToday = addDays(startOfDay(now, zone), 1, zone)
  const confirmed = transactions.filter(isConfirmed)
  const points: NetWorthPoint[] = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const month = addMonths(current, -offset)
    if (compareMonths(month, first) < 0) continue
    // Exclusive: the instant right after the moment the month is valued at.
    const cutoff = (sameMonth(month, current) ? endOfToday : monthInterval(month, zone).end).getTime()
    const movements = confirmed.filter((transaction) => new Date(transaction.date).getTime() < cutoff)
    const balances = accounts
      .filter((account) => startOfDay(new Date(account.openingDate), zone).getTime() < cutoff)
      .flatMap((account) => balanceOf(account, movements, zone))
    points.push({ month, total: netWorth(balances, { ...settings, rate: rateBefore(movements, settings) }) })
  }
  return points
}

/**
 * The rate stored by the latest of `movements` (already confirmed and dated before the cutoff) that
 * converts between today's two currencies; today's settings rate when none does. A rate for another
 * pair (single-currency, or from before the currencies were changed) says nothing about this one.
 * The first of equally dated movements wins, as on iOS.
 */
function rateBefore(movements: readonly Transaction[], settings: CurrencySettings): string {
  if (settings.second === undefined) return settings.rate
  let latest: Transaction | undefined
  let latestTime = -Infinity
  for (const movement of movements) {
    const rate = movement.exchangeRate
    if (rate.principal !== settings.principal || rate.second !== settings.second) continue
    const time = new Date(movement.date).getTime()
    if (time <= latestTime) continue
    latest = movement
    latestTime = time
  }
  return latest?.exchangeRate.rate ?? settings.rate
}

/** The latest month against the first one shown; `undefined` with fewer than two months. */
export function netWorthChange(points: readonly NetWorthPoint[]): Decimal | undefined {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last || points.length < 2) return undefined
  return last.total.amount.minus(first.total.amount)
}
