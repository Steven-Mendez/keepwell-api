import { apnsConfig, vapidConfig, type AppConfig } from "../config/config"
import type { Logger } from "../observability/logger"
import type { PushSender } from "../../core/ports/push"
import { ApnsSender } from "./apns"
import { InMemoryPushSender, PlatformPushSender } from "./senders"
import { WebPushSender } from "./web-push"

/**
 * The sender for this configuration. Each platform is on only when its secrets are set (ADR 0008's
 * habit: capability by configuration); a push for one that isn't is logged and counted as failed.
 * Locally, with no push secrets at all, an in-memory sender stands in and logs what it would send.
 */
export function createPushSender(config: AppConfig, options: { local: boolean; logger: Logger }): PushSender {
  const apns = apnsConfig(config)
  const web = vapidConfig(config)
  if (!apns && !web && options.local) {
    const fake = new InMemoryPushSender()
    return {
      async send(device, message) {
        options.logger.info({ platform: device.platform, type: message.type }, "push (not sent: no push secrets configured locally)")
        return fake.send(device, message)
      },
    }
  }
  return new PlatformPushSender({ apns: apns ? new ApnsSender(apns) : undefined, web: web ? new WebPushSender(web) : undefined }, (platform) =>
    options.logger.warn({ platform }, "push skipped: not configured")
  )
}
