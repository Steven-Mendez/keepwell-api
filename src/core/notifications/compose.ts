import { ledgerNotifications, zonedParts, type Ledger, type LedgerNotification, type NotificationKind } from "../domain/domain"
import { makeTranslator, type Locale, type Translator } from "../domain/i18n/translate"
import { notificationCopy } from "../domain/presentation/notification-copy"
import type { LedgerRows } from "../ledger/wire-to-domain"

/** The hour (device time) from which dated notifications are sent. A setting later (ADR 0012). */
export const REMINDER_HOUR = 9

/** Budget and price notifications don't wait for the hour: they are sent as soon as the job sees them. */
const IMMEDIATE: ReadonlySet<NotificationKind> = new Set(["budget", "price"])

export interface NotificationStates {
  read: ReadonlySet<string>
  dismissed: ReadonlySet<string>
}

/** `notificationState` rows as the sets the rules need. Tombstoned rows count for nothing. */
export function statesOf(rows: LedgerRows["notificationState"]): NotificationStates {
  const live = rows.filter((row) => row.deleted_at === null)
  return {
    read: new Set(live.filter((row) => row.read_at !== null).map((row) => row.id)),
    dismissed: new Set(live.filter((row) => row.dismissed_at !== null).map((row) => row.id)),
  }
}

/** "es", "es-NI", "es_MX" → Spanish; everything else English, the catalogs' two languages. */
export function localeOf(tag: string): Locale {
  return /^es(?:[-_]|$)/i.test(tag) ? "es" : "en"
}

/**
 * What the app's inbox counts as unread, which is also the badge: what applies, minus what was
 * deleted or read, without drafts (Home lists those).
 */
export function unreadCount(ledger: Ledger, states: NotificationStates, now: Date): number {
  return ledgerNotifications(ledger, now).filter((n) => n.kind !== "planned" && !states.dismissed.has(n.id) && !states.read.has(n.id)).length
}

/**
 * The notifications to push now, in the person's home zone (`ledger.timeZone`, see
 * `ReadLedger.timeZone`), which the domain is handed, never the process's:
 *
 * - not read and not deleted on any device (`notificationState`),
 * - applying today or earlier (`date`), and, for the dated kinds, only from `REMINDER_HOUR` local;
 *   budget and price ones as soon as they appear,
 * - not already delivered (that is the caller's `claim`, atomic; `delivered` only saves work).
 */
export function dueNotifications(input: { ledger: Ledger; states: NotificationStates; delivered: ReadonlySet<string>; now: Date }): LedgerNotification[] {
  const { ledger, states, delivered, now } = input
  const afterHour = zonedParts(now, ledger.timeZone).hour >= REMINDER_HOUR
  return ledgerNotifications(ledger, now).filter((n) => {
    if (states.read.has(n.id) || states.dismissed.has(n.id) || delivered.has(n.id)) return false
    if (n.date.getTime() > now.getTime()) return false
    return IMMEDIATE.has(n.kind) || afterHour
  })
}

/** Words notifications with the shared catalogs, once per (language, notification). */
export class NotificationWording {
  private readonly translators = new Map<Locale, Translator>()

  constructor(private readonly ledger: Ledger) {}

  /** Never masks amounts: a push already goes to the person's own devices, as the apps' banners do. */
  copy(notification: LedgerNotification, locale: Locale) {
    let t = this.translators.get(locale)
    if (!t) this.translators.set(locale, (t = makeTranslator(locale)))
    return notificationCopy(t, this.ledger, notification, false)
  }
}
