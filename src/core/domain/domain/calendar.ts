/**
 * Calendar math in an explicit IANA time zone. Dates are JS `Date` instants; months are `YearMonth`
 * values without a time zone. Every function that turns an instant into a day or a month takes the
 * zone: the apps pass the device's (like iOS `Calendar.current`), the server the person's home zone
 * from their settings. Nothing here reads the zone of the process, so one server can compute for
 * people in different zones at once.
 */
export interface YearMonth {
  readonly year: number
  /** 1…12 */
  readonly month: number
}

/** An IANA time zone name the runtime knows ("America/Managua"), as `resolveTimeZone` returns it. */
export type TimeZone = string

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: TimeZone): Intl.DateTimeFormat {
  let found = formatters.get(zone)
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", era: "short" })
    formatters.set(zone, found)
  }
  return found
}

/** Whether the runtime knows `zone` as an IANA time zone. */
export function isTimeZone(zone: string | null | undefined): zone is TimeZone {
  if (!zone) return false
  try {
    formatter(zone)
    return true
  } catch {
    return false
  }
}

/** `candidate` when the runtime knows it, else `fallback`, else UTC. */
export function resolveTimeZone(candidate: string | null | undefined, fallback?: string | null): TimeZone {
  if (isTimeZone(candidate)) return candidate
  if (isTimeZone(fallback)) return fallback
  return "UTC"
}

const MINUTE = 60_000
/** Offsets are cached per quarter hour: every zone changes offset on a quarter hour or not at all. */
const BUCKET = 15 * MINUTE
const offsets = new Map<string, number>()

/** Milliseconds to add to UTC to get the wall clock of `zone` at `instant`. */
function offsetAt(instant: number, zone: TimeZone): number {
  const bucket = Math.floor(instant / BUCKET)
  const key = `${zone} ${bucket}`
  const cached = offsets.get(key)
  if (cached !== undefined) return cached
  const at = bucket * BUCKET
  const parts: Record<string, string> = {}
  for (const part of formatter(zone).formatToParts(new Date(at))) parts[part.type] = part.value
  const year = parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year)
  const wall = Date.UTC(year, Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  const offset = wall - at
  if (offsets.size > 50_000) offsets.clear()
  offsets.set(key, offset)
  return offset
}

/** The wall clock of `zone` at `date`. `month` is 1…12; `weekday` is 0 (Sunday)…6. */
export interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly millisecond: number
  readonly weekday: number
}

export function zonedParts(date: Date, zone: TimeZone): ZonedParts {
  const wall = new Date(date.getTime() + offsetAt(date.getTime(), zone))
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    millisecond: wall.getUTCMilliseconds(),
    weekday: wall.getUTCDay(),
  }
}

/**
 * The instant a wall clock of `zone` shows, like `new Date(year, month - 1, day, …)` in that zone:
 * out-of-range parts carry over (day 0 is the last of the previous month), a time skipped by a
 * daylight-saving jump moves forward by the jump, and a time that happens twice is the first one.
 */
export function zonedDate(zone: TimeZone, year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  // At most one transition is that close to a given wall clock, so these are the two candidates.
  const before = offsetAt(wall - 26 * 60 * MINUTE, zone)
  const after = offsetAt(wall + 26 * 60 * MINUTE, zone)
  const fits = [before, after].map((offset) => wall - offset).filter((instant) => offsetAt(instant, zone) === wall - instant)
  if (fits.length > 0) return new Date(Math.min(...fits))
  return new Date(wall - before)
}

export function yearMonth(year: number, month: number): YearMonth | undefined {
  return month >= 1 && month <= 12 ? { year, month } : undefined
}

export function yearMonthContaining(date: Date, zone: TimeZone): YearMonth {
  const parts = zonedParts(date, zone)
  return { year: parts.year, month: parts.month }
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

export function monthInterval(value: YearMonth, zone: TimeZone): DateInterval {
  return { start: zonedDate(zone, value.year, value.month, 1), end: zonedDate(zone, value.year, value.month + 1, 1) }
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** The same in every zone. */
export function daysInMonth(value: YearMonth): number {
  const leap = (value.year % 4 === 0 && value.year % 100 !== 0) || value.year % 400 === 0
  return value.month === 2 && leap ? 29 : MONTH_DAYS[value.month - 1]!
}

export function startOfDay(date: Date, zone: TimeZone): Date {
  const parts = zonedParts(date, zone)
  return zonedDate(zone, parts.year, parts.month, parts.day)
}

/** `days` calendar days later in `zone`, same wall-clock time (not `days × 24 h` across a DST change). */
export function addDays(date: Date, days: number, zone: TimeZone): Date {
  const parts = zonedParts(date, zone)
  return zonedDate(zone, parts.year, parts.month, parts.day + days, parts.hour, parts.minute, parts.second, parts.millisecond)
}

export function contains(interval: DateInterval, date: Date): boolean {
  return date.getTime() >= interval.start.getTime() && date.getTime() < interval.end.getTime()
}

/** "2026-10-22": the day `date` falls on in `zone`. */
export function dayKey(date: Date, zone: TimeZone): string {
  const parts = zonedParts(date, zone)
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`
}

/** Reads "2026-10-22" as that day at noon in `zone`, so a few hours of difference can't move it to another day. */
export function parseDayKey(text: string, zone: TimeZone): Date | undefined {
  const parts = text.slice(0, 10).split("-").map((part) => Number.parseInt(part, 10))
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return undefined
  const [year, month, day] = parts as [number, number, number]
  const date = zonedDate(zone, year, month, day, 12)
  return Number.isNaN(date.getTime()) ? undefined : date
}
