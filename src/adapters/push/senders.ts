import type { PushDevice, PushMessage, PushSender, SendResult } from "../../core/ports/push"
import type { ApnsSender } from "./apns"
import type { WebPushSender } from "./web-push"

/** Routes by platform. A platform without configuration is skipped (`failed`, never `gone`: nothing is wrong with the device). */
export class PlatformPushSender implements PushSender {
  constructor(
    private readonly senders: { apns?: ApnsSender | undefined; web?: WebPushSender | undefined },
    private readonly onSkipped?: (platform: string) => void
  ) {}

  async send(device: PushDevice, message: PushMessage): Promise<SendResult> {
    const sender = device.platform === "ios" ? this.senders.apns : this.senders.web
    if (!sender) {
      this.onSkipped?.(device.platform)
      return "failed"
    }
    return sender.send(device, message)
  }
}

/** For local development and tests: remembers what would have been pushed. */
export class InMemoryPushSender implements PushSender {
  readonly sent: { device: PushDevice; message: PushMessage }[] = []
  /** Outcome per client id; anything else is `sent`. */
  outcomes = new Map<string, SendResult>()

  async send(device: PushDevice, message: PushMessage): Promise<SendResult> {
    const outcome = this.outcomes.get(device.clientId) ?? "sent"
    if (outcome === "sent") this.sent.push({ device, message })
    return outcome
  }
}
