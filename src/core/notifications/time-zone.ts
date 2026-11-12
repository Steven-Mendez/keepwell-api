/**
 * The domain computes "today" with the local `Date` getters (`startOfDay`, `getHours`...), because
 * on the web and on iOS local is the person's. The server's process is not in the person's zone, so
 * the calculation runs with the process zone switched to theirs: `process.env.TZ` is read again on
 * every assignment, and `inTimeZone` restores it afterwards.
 *
 * Contract and edge cases:
 * - `fn` must be synchronous. A switch held across an `await` would leak into other work.
 * - An unknown zone name falls back to UTC (`resolveTimeZone`), never to the process zone.
 * - Days are the zone's calendar days, so an id like `payment:<account>:2026-12-01` matches what
 *   that device computes. At a DST jump a day is 23 or 25 hours long; the domain's day arithmetic
 *   (`startOfDay`, `addDays`) is calendar based and copes.
 * - A zone in which midnight does not exist (a few historic zones) is not handled specially.
 */
export function inTimeZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = resolveTimeZone(zone)
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export function resolveTimeZone(zone: string): string {
  return isTimeZone(zone) ? zone : "UTC"
}
