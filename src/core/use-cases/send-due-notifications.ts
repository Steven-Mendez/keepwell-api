import type { LedgerNotification } from "../domain/domain"
import { dueNotifications, localeOf, NotificationWording, statesOf, unreadCount } from "../notifications/compose"
import { forgetGoneDevice, type DeliveryStore, type PushDeviceStore, type PushMessage, type PushSender } from "../ports/push"
import type { ReadLedger } from "./read-ledger"

/** Deliveries are kept this long, enough to remember anything the ledger can still produce. */
export const DELIVERY_RETENTION_DAYS = 120
/**
 * At most this many pushes per person per run. A new device on an old ledger would otherwise get
 * every pending draft at once; the rest follow on the next runs, 15 minutes apart.
 */
export const MAX_PER_USER_RUN = 10

export interface JobLog {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

export interface SendSummary {
  users: number
  sent: number
  failed: number
  devicesRemoved: number
  pruned: number
  /** People whose run threw (the others went ahead). */
  userErrors: number
}

/**
 * The scheduled job (ADR 0012): for each person with a push device, the notifications that apply
 * today, minus the ones read or deleted on any device and the ones already delivered, sent once.
 *
 * - The clock that matters is the person's: the calculation runs in their home zone (settings, else
 *   their most recently seen device, see `ReadLedger.timeZone`) and the 09:00 rule is read there. The pushes go to all their devices,
 *   worded in each device's language.
 * - A delivery is recorded (`claim`, a unique insert) *before* sending, so two overlapping runs, or
 *   a retry after a crash, can't notify twice. If the send fails everywhere the claim is released
 *   so the next run tries again; a crash between claim and send loses at most that notification,
 *   never duplicates it.
 * - One person failing doesn't stop the rest.
 */
export class SendDueNotifications {
  constructor(
    private readonly deps: {
      devices: PushDeviceStore
      deliveries: DeliveryStore
      ledger: ReadLedger
      sender: PushSender
      log: JobLog
      clock?: () => Date
    }
  ) {}

  async execute(): Promise<SendSummary> {
    const { devices, deliveries, log } = this.deps
    const now = (this.deps.clock ?? (() => new Date()))()
    const summary: SendSummary = { users: 0, sent: 0, failed: 0, devicesRemoved: 0, pruned: 0, userErrors: 0 }
    for (const userId of await devices.usersWithDevices()) {
      summary.users++
      try {
        const result = await this.forUser(userId, now)
        summary.sent += result.sent
        summary.failed += result.failed
        summary.devicesRemoved += result.removed
      } catch (error) {
        summary.userErrors++
        log.error({ err: error, user_id: userId }, "notifications for a user failed")
      }
    }
    summary.pruned = await deliveries.prune(new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 86_400_000)).catch((error: unknown) => {
      log.error({ err: error }, "pruning deliveries failed")
      return 0
    })
    log.info({ metric: "notifications_job", ...summary }, "notifications job done")
    return summary
  }

  private async forUser(userId: string, now: Date) {
    const { devices, deliveries, sender } = this.deps
    const result = { sent: 0, failed: 0, removed: 0 }
    let targets = await devices.list(userId)
    if (targets.length === 0) return result
    const { ledger, rows } = await this.deps.ledger.load(userId)
    const states = statesOf(rows.notificationState)
    const due = dueNotifications({ ledger, states, delivered: new Set(), now })
    if (due.length === 0) return result
    const badge = unreadCount(ledger, states, now)
    const wording = new NotificationWording(ledger)

    let budget = MAX_PER_USER_RUN
    for (const notification of due) {
      if (budget === 0) break
      if (targets.length === 0) break
      if (!(await deliveries.claim(userId, notification.id, now))) continue
      budget--
      const outcomes = await Promise.all(
        targets.map(async (device) => {
          const message = notificationMessage(notification, wording.copy(notification, localeOf(device.locale)), badge)
          return { device, outcome: await sender.send(device, message).catch((error: unknown) => {
            this.deps.log.warn({ err: error, platform: device.platform }, "push send threw")
            return "failed" as const
          }) }
        })
      )
      for (const { device, outcome } of outcomes) {
        if (outcome === "gone" && forgetGoneDevice(device, now)) {
          await devices.removeWithToken(userId, device.clientId, device.token)
          result.removed++
        }
      }
      targets = targets.filter((device) => !outcomes.some((o) => o.outcome === "gone" && o.device.id === device.id))
      const delivered = outcomes.filter((o) => o.outcome === "sent").length
      if (delivered > 0) result.sent++
      else {
        result.failed++
        await deliveries.release(userId, notification.id)
      }
    }
    return result
  }
}

export function notificationMessage(notification: LedgerNotification, copy: { title: string; body: string }, badge: number): PushMessage {
  return {
    type: "notification",
    id: notification.id,
    kind: notification.kind,
    title: copy.title,
    body: copy.body,
    target: notification.target,
    badge,
    ...(notification.kind === "planned" ? { transactionId: notification.params.transactionId } : {}),
  }
}
