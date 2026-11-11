import type { Lang } from "./app"

/**
 * Amounts arrive as exact decimal text with their ISO 4217 code. They are shown, never added up here:
 * the API already did the arithmetic in decimals. Number() is only for display and bar lengths.
 */
export function money(amount: string, currency: string, _lang: Lang): string {
  const value = Number(amount)
  if (!Number.isFinite(value)) return `${amount} ${currency}`
  try {
    // Locale independent, like Keepwell's apps (CurrencyFormatter): $1,200.50 in either language.
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

/** "2026-11" → "November 2026" / "noviembre de 2026". */
export function monthName(month: string, lang: Lang, short = false): string {
  const [year, number] = month.split("-").map(Number)
  if (!year || !number) return month
  return new Intl.DateTimeFormat(lang, short ? { month: "short" } : { month: "long", year: "numeric" }).format(new Date(year, number - 1, 15))
}

/** "2026-11-14" → "Fri, Nov 14" / "vie, 14 nov". Read as a calendar day, not an instant. */
export function dayName(date: string, lang: Lang): string {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number)
  if (!year || !month || !day) return date
  return new Intl.DateTimeFormat(lang, { weekday: "short", month: "short", day: "numeric" }).format(new Date(year, month - 1, day, 12))
}

export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number)
  const date = new Date(year ?? 2000, (number ?? 1) - 1 + by, 15)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
}
