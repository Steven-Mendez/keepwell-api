import { parseDayKey, type TimeZone } from "../domain/domain"

/**
 * A date an assistant sent, as the instant to store. "2026-11-12" is that day in the person's home
 * zone, at noon like the apps' date pickers (`parseDayKey`), so a few hours either way can't move it
 * to another day; `new Date("2026-11-12")` would read UTC midnight, the 11th in the Americas. A
 * date-time names its own instant.
 */
export function instantIn(text: string, zone: TimeZone): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return parseDayKey(text, zone) ?? new Date(text)
  return new Date(text)
}
