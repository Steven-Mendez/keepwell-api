import type { Transaction } from "../schema"
import { addMonths, compareMonths, daysInMonth, monthKey, yearMonthContaining, zonedDate, zonedParts, type TimeZone, type YearMonth } from "./calendar"
import { Decimal, ZERO, sum } from "./decimal"
import { cashFlowTrend, categoryBreakdown, type CashFlowTrend, type CategoryBreakdown } from "./overviews"
import { debtLinks, isConfirmed, monthlySummary, savings, type CategoryTotal, type MonthlySummary, type SpendingDebts } from "./rules"

// Trends: any span of whole months read as one period (a year, the last 12 months, March–August),
// next to the same months a year earlier. Web only: the iPhone keeps Summary to one month at a time.

/** Inclusive on both ends; `start` never comes after `end`. */
export interface MonthRange {
  readonly start: YearMonth
  readonly end: YearMonth
}

/** The two months in either order: picking the end first is still a valid range. */
export function monthRange(a: YearMonth, b: YearMonth): MonthRange {
  return compareMonths(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a }
}

export function rangeLength(range: MonthRange): number {
  return (range.end.year - range.start.year) * 12 + (range.end.month - range.start.month) + 1
}

export function rangeMonths(range: MonthRange): YearMonth[] {
  return Array.from({ length: rangeLength(range) }, (_, index) => addMonths(range.start, index))
}

export function shiftRange(range: MonthRange, months: number): MonthRange {
  return { start: addMonths(range.start, months), end: addMonths(range.end, months) }
}

/**
 * What a period is measured against. Up to a year: the same months one year earlier, so December
 * is compared with a December and seasons don't read as trends. Longer: the stretch of the same
 * length right before it, since shifting by a year would overlap the period itself.
 */
export function comparisonShift(range: MonthRange): number {
  const length = rangeLength(range)
  return length <= 12 ? 12 : length
}

/** January through the running month. */
export function yearToDate(now: Date, zone: TimeZone): MonthRange {
  const current = yearMonthContaining(now, zone)
  return { start: { year: current.year, month: 1 }, end: current }
}

export function calendarYear(year: number): MonthRange {
  return { start: { year, month: 1 }, end: { year, month: 12 } }
}

/** `count` months ending with the running one. */
export function lastMonths(count: number, now: Date, zone: TimeZone): MonthRange {
  const current = yearMonthContaining(now, zone)
  return { start: addMonths(current, -(count - 1)), end: current }
}

/** First month with confirmed income or spending through the running month; `undefined` before any. */
export function activityRange(transactions: readonly Transaction[], now: Date, zone: TimeZone): MonthRange | undefined {
  let first: YearMonth | undefined
  for (const transaction of transactions) {
    if (!counts(transaction)) continue
    const month = yearMonthContaining(new Date(transaction.date), zone)
    if (!first || compareMonths(month, first) < 0) first = month
  }
  const current = yearMonthContaining(now, zone)
  if (!first) return undefined
  return monthRange(first, current)
}

/** A category in the period next to what it was in the comparison period. */
export interface CategoryChange {
  categoryId: string
  amount: Decimal
  /** Share of the period's total (0…1). */
  share: Decimal
  previous: Decimal
  /** `amount − previous`; positive means more than before. */
  change: Decimal
  /** `change / previous`; `undefined` when the category is new, where a percentage means nothing. */
  changeRate?: Decimal
}

/** One category's amount per month of the period, in the period's order. */
export interface CategoryTrend {
  categoryId: string
  amounts: Decimal[]
}

export interface TrendReport {
  currency: string
  range: MonthRange
  comparison: MonthRange
  /** One per month of `range`, oldest first. */
  months: MonthlySummary[]
  /** Aligned with `months`: index 3 here is index 3 there. */
  comparisonMonths: MonthlySummary[]
  cashFlow: CashFlowTrend
  comparisonCashFlow: CashFlowTrend
  /** Whether the comparison period had any income or spending; without it every "vs" is noise. */
  hasComparison: boolean
  /** The running month is in the range, so the period isn't over (and was compared to the same day). */
  isRunning: boolean
  /** Per month, over the months that had spending (or income), like `averageMonthlyTotal`. */
  averageExpense?: Decimal
  averageIncome?: Decimal
  /** The month that kept the most, and the one that kept the least; only months with movements. */
  bestMonth?: MonthlySummary
  worstMonth?: MonthlySummary
  /** Every category of either period, largest in this one first. */
  expenseCategories: CategoryChange[]
  incomeCategories: CategoryChange[]
  expenseBreakdown: CategoryBreakdown
  incomeBreakdown: CategoryBreakdown
  /** The category whose spending grew the most in money, and the one that dropped the most. */
  biggestIncrease?: CategoryChange
  biggestDecrease?: CategoryChange
  /** Savings added up month by month, so the last point is the period's total. */
  cumulativeSavings: Decimal[]
  comparisonCumulativeSavings: Decimal[]
  /** The largest spending categories, month by month. */
  categoryTrends: CategoryTrend[]
}

export const TREND_CATEGORY_COUNT = 4

const counts = (transaction: Transaction) => isConfirmed(transaction) && transaction.kind !== "transfer"

function byMonth(transactions: readonly Transaction[], zone: TimeZone, until?: Date): Map<string, Transaction[]> {
  const buckets = new Map<string, Transaction[]>()
  for (const transaction of transactions) {
    if (!counts(transaction)) continue
    const date = new Date(transaction.date)
    if (until && date > until) continue
    const key = monthKey(yearMonthContaining(date, zone))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(transaction)
    else buckets.set(key, [transaction])
  }
  return buckets
}

function averageOf(values: readonly Decimal[]): Decimal | undefined {
  const active = values.filter((value) => value.gt(0))
  return active.length === 0 ? undefined : sum(active).div(active.length)
}

function running(values: readonly Decimal[]): Decimal[] {
  let total = ZERO
  return values.map((value) => (total = total.plus(value)))
}

function totalsOf(months: readonly MonthlySummary[], pick: (month: MonthlySummary) => CategoryTotal[]): Map<string, Decimal> {
  const totals = new Map<string, Decimal>()
  for (const month of months) for (const entry of pick(month)) totals.set(entry.categoryId, (totals.get(entry.categoryId) ?? ZERO).plus(entry.amount))
  return totals
}

function changes(current: Map<string, Decimal>, previous: Map<string, Decimal>): CategoryChange[] {
  const total = sum([...current.values()])
  const ids = new Set([...current.keys(), ...previous.keys()])
  return [...ids]
    .map((categoryId) => {
      const amount = current.get(categoryId) ?? ZERO
      const before = previous.get(categoryId) ?? ZERO
      const change = amount.minus(before)
      return {
        categoryId,
        amount,
        share: total.gt(0) ? amount.div(total) : ZERO,
        previous: before,
        change,
        ...(before.gt(0) ? { changeRate: change.div(before) } : {}),
      }
    })
    .sort((a, b) => (!a.amount.eq(b.amount) ? b.amount.cmp(a.amount) : !a.previous.eq(b.previous) ? b.previous.cmp(a.previous) : a.categoryId < b.categoryId ? -1 : 1))
}

const ranked = (entries: CategoryChange[]): CategoryTotal[] =>
  entries.filter((entry) => entry.amount.gt(0)).map(({ categoryId, amount, share }) => ({ categoryId, amount, share }))

/** The same instant `months` earlier, clamped to the shorter month (March 31 → February 28). */
function monthsBefore(date: Date, months: number, zone: TimeZone): Date {
  const parts = zonedParts(date, zone)
  const month = addMonths(parts, -months)
  return zonedDate(zone, month.year, month.month, Math.min(parts.day, daysInMonth(month)), parts.hour, parts.minute, parts.second, parts.millisecond)
}

/**
 * Everything the Trends page draws for `range`. Months after the running one are dropped, since
 * they can't have confirmed movements yet. When the running month is in the range, its counterpart
 * in the comparison is cut at the same day, so a half-finished November isn't measured against a
 * whole one.
 */
export function trendReport(transactions: readonly Transaction[], currency: string, requested: MonthRange, zone: TimeZone, now: Date = new Date(), debts: SpendingDebts = []): TrendReport {
  const links = debtLinks(debts)
  const current = yearMonthContaining(now, zone)
  const end = compareMonths(requested.end, current) > 0 ? current : requested.end
  const range = monthRange(requested.start, end)
  const isRunning = compareMonths(range.end, current) === 0
  const shift = comparisonShift(range)
  const comparison = shiftRange(range, -shift)

  const buckets = byMonth(transactions, zone)
  const months = rangeMonths(range).map((month) => monthlySummary(month, buckets.get(monthKey(month)) ?? [], currency, zone, links))
  // Only the running month's counterpart is cut; the rest of the comparison is whole months.
  const cutBuckets = isRunning ? byMonth(transactions, zone, monthsBefore(now, shift, zone)) : buckets
  const comparisonMonths = rangeMonths(comparison).map((month, index, all) => {
    const source = index === all.length - 1 ? cutBuckets : buckets
    return monthlySummary(month, source.get(monthKey(month)) ?? [], currency, zone, links)
  })

  const cashFlow = cashFlowTrend(months)
  const comparisonCashFlow = cashFlowTrend(comparisonMonths)
  const hasComparison = comparisonCashFlow.income.gt(0) || comparisonCashFlow.expense.gt(0)

  const active = months.filter((month) => month.income.gt(0) || month.expense.gt(0))
  const bySavings = [...active].sort((a, b) => savings(b).cmp(savings(a)) || compareMonths(a.month, b.month))
  const bestMonth = bySavings[0]
  const worstMonth = bySavings.length > 1 ? bySavings.at(-1) : undefined

  const expenseCategories = changes(totalsOf(months, (month) => month.categories), totalsOf(comparisonMonths, (month) => month.categories))
  const incomeCategories = changes(totalsOf(months, (month) => month.incomeCategories), totalsOf(comparisonMonths, (month) => month.incomeCategories))

  // A category that grew from nothing is "new", not "up"; only compare when the old period spent.
  const comparable = comparisonCashFlow.expense.gt(0) ? expenseCategories : []
  const increases = comparable.filter((entry) => entry.change.gt(0)).sort((a, b) => b.change.cmp(a.change))
  const decreases = comparable.filter((entry) => entry.change.lt(0)).sort((a, b) => a.change.cmp(b.change))

  const averageExpense = averageOf(months.map((month) => month.expense))
  const averageIncome = averageOf(months.map((month) => month.income))

  const top = expenseCategories.filter((entry) => entry.amount.gt(0)).slice(0, TREND_CATEGORY_COUNT)
  const categoryTrends = top.map(({ categoryId }) => ({
    categoryId,
    amounts: months.map((month) => month.categories.find((entry) => entry.categoryId === categoryId)?.amount ?? ZERO),
  }))

  return {
    currency,
    range,
    comparison,
    months,
    comparisonMonths,
    cashFlow,
    comparisonCashFlow,
    hasComparison,
    isRunning,
    ...(averageExpense ? { averageExpense } : {}),
    ...(averageIncome ? { averageIncome } : {}),
    ...(bestMonth ? { bestMonth } : {}),
    ...(worstMonth ? { worstMonth } : {}),
    expenseCategories,
    incomeCategories,
    expenseBreakdown: categoryBreakdown(ranked(expenseCategories)),
    incomeBreakdown: categoryBreakdown(ranked(incomeCategories)),
    ...(increases[0] ? { biggestIncrease: increases[0] } : {}),
    ...(decreases[0] ? { biggestDecrease: decreases[0] } : {}),
    cumulativeSavings: running(months.map(savings)),
    comparisonCumulativeSavings: running(comparisonMonths.map(savings)),
    categoryTrends,
  }
}

/** One calendar year's totals, for the year-over-year bars. */
export interface YearTotals {
  year: number
  cashFlow: CashFlowTrend
  /** The running year: its total is only through today. */
  isRunning: boolean
}

/** Every year from the first movement through the running one, oldest first. */
export function yearTotals(transactions: readonly Transaction[], currency: string, zone: TimeZone, now: Date = new Date(), debts: SpendingDebts = []): YearTotals[] {
  const links = debtLinks(debts)
  const activity = activityRange(transactions, now, zone)
  if (!activity) return []
  const buckets = byMonth(transactions, zone)
  const years: YearTotals[] = []
  for (let year = activity.start.year; year <= activity.end.year; year++) {
    const months = rangeMonths(calendarYear(year)).map((month) => monthlySummary(month, buckets.get(monthKey(month)) ?? [], currency, zone, links))
    years.push({ year, cashFlow: cashFlowTrend(months), isRunning: year === activity.end.year })
  }
  return years
}
