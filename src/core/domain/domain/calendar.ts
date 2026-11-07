/**
 * Calendar math in the person's time zone (the device's, like iOS `Calendar.current`). Dates are JS
 * `Date` instants; months are `YearMonth` values without a time zone.
 */
export interface YearMonth {
  readonly year: number
  /** 1…12 */
  readonly month: number
}

export function yearMonth(year: number, month: number): YearMonth | undefined {
  return month >= 1 && month <= 12 ? { year, month } : undefined
}

export function yearMonthContaining(date: Date): YearMonth {
  return { year: date.getFullYear(), month: date.getMonth() + 1 }
}

export function addMonths(value: YearMonth, months: number): YearMonth {
  const index = value.year * 12 + (value.month - 1) + months
  const year = Math.floor(index / 12)
  return { year, month: index - year * 12 + 1 }
}

export function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month
}

export function compareMonths(a: YearMonth, b: YearMonth): number {
  return a.year === b.year ? a.month - b.month : a.year - b.year
}

export function monthKey(value: YearMonth): string {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}`
}

/** Half-open `[first day 00:00, first day of next month 00:00)`. */
export interface DateInterval {
  readonly start: Date
  readonly end: Date
}

export function monthInterval(value: YearMonth): DateInterval {
  return { start: new Date(value.year, value.month - 1, 1), end: new Date(value.year, value.month, 1) }
}

export function daysInMonth(value: YearMonth): number {
  return new Date(value.year, value.month, 0).getDate()
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
}

export function contains(interval: DateInterval, date: Date): boolean {
  return date.getTime() >= interval.start.getTime() && date.getTime() < interval.end.getTime()
}

/** "2026-10-22" in the person's calendar. */
export function dayKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/** Reads "2026-10-22" as that day at noon, so time zones can't move it to another day. */
export function parseDayKey(text: string): Date | undefined {
  const parts = text.slice(0, 10).split("-").map((part) => Number.parseInt(part, 10))
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return undefined
  const [year, month, day] = parts as [number, number, number]
  const date = new Date(year, month - 1, day, 12)
  return Number.isNaN(date.getTime()) ? undefined : date
}
