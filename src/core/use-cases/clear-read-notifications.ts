import { resolveTimeZone } from "../notifications/time-zone"
import { statesOf, unreadCount } from "../notifications/compose"
import { forgetGoneDevice, type PushDeviceStore, type PushSender } from "../ports/push"
import type { JobLog } from "./send-due-notifications"
import type { ReadLedger } from "./read-ledger"

/**
 * After a sync push that made notifications read or deleted on one device, tells the person's other
 * devices to take them off the screen (ADR 0012): the iPhone's silent push with `clear_ids` and the
 * new badge, the browser's `{type:"clear"}`. Never throws: a failure here must not fail the sync
 * request that caused it.
 */
export class ClearReadNotifications {
  constructor(
    private readonly deps: { devices: PushDeviceStore; ledger: ReadLedger; sender: PushSender; log: JobLog; clock?: () => Date }
  ) {}

  async execute(input: { userId: string; clientId: string; ids: string[] }): Promise<void> {
    const { devices, sender, log } = this.deps
    try {
      if (input.ids.length === 0) return
      const all = await devices.list(input.userId)
      const others = all.filter((device) => device.clientId !== input.clientId)
      if (others.length === 0) return
      const zone = resolveTimeZone([...all].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0]!.timeZone)
      const { ledger, rows } = await this.deps.ledger.load(input.userId)
      const now = (this.deps.clock ?? (() => new Date()))()
      const badge = unreadCount(ledger, statesOf(rows.notificationState), now, zone)
      await Promise.all(
        others.map(async (device) => {
          const outcome = await sender.send(device, { type: "clear", ids: input.ids, badge }).catch((error: unknown) => {
            log.warn({ err: error, platform: device.platform }, "silent clear threw")
            return "failed" as const
          })
          if (outcome === "gone" && forgetGoneDevice(device, now)) await devices.removeWithToken(input.userId, device.clientId, device.token)
        })
      )
      log.info({ metric: "notifications_clear", devices: others.length, ids: input.ids.length }, "silent clear sent")
    } catch (error) {
      log.error({ err: error }, "silent clear failed")
    }
  }
}
