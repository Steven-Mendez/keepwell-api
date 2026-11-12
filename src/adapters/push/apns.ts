import { createHash } from "node:crypto"
import { connect, constants, type ClientHttp2Session } from "node:http2"

import { importPKCS8, SignJWT } from "jose"

import type { ApnsConfig } from "../config/config"
import type { PushDevice, PushMessage, SendResult } from "../../core/ports/push"

// APNs over HTTP/2 with a provider token (ES256 JWT from the .p8 key). Apple asks for a token that is
// reused, refreshed at most every 20 minutes and no later than an hour: it is cached for 50.

export const APNS_HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const
const TOKEN_TTL_MS = 50 * 60_000

export interface ApnsRequest {
  path: string
  headers: Record<string, string>
  body: string
}

/** `apns-collapse-id` allows 64 bytes: a longer notification id travels as its SHA-256 hex, cut to 64. */
export function collapseId(id: string): string {
  return Buffer.byteLength(id) <= 64 ? id : createHash("sha256").update(id).digest("hex").slice(0, 64)
}

/** The request for one message (ADR 0012, "Payloads"), without the authorization header. */
export function apnsRequest(token: string, message: PushMessage, topic: string): ApnsRequest {
  const path = `/3/device/${token}`
  if (message.type === "clear") {
    return {
      path,
      headers: { "apns-topic": topic, "apns-push-type": "background", "apns-priority": "5" },
      body: JSON.stringify({ aps: { "content-available": 1, badge: message.badge }, clear_ids: message.ids }),
    }
  }
  const aps: Record<string, unknown> = {
    alert: { title: message.title, body: message.body },
    sound: "default",
    "thread-id": message.kind,
    badge: message.badge,
    // The app's "Confirm" and "Postpone" actions hang off this category (drafts only).
    ...(message.transactionId ? { category: "keepwell.planned" } : {}),
  }
  return {
    path,
    headers: { "apns-topic": topic, "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": collapseId(message.id) },
    body: JSON.stringify({
      aps,
      notification_id: message.id,
      target: message.target,
      // The app reads the transaction id in Swift's uppercase form.
      ...(message.transactionId ? { transactionID: message.transactionId.toUpperCase() } : {}),
    }),
  }
}

/** 410 (Unregistered) and 400 BadDeviceToken mean the token is dead for good. */
export function apnsOutcome(status: number, body: string): SendResult {
  if (status === 200) return "sent"
  let reason = ""
  try {
    reason = (JSON.parse(body) as { reason?: string }).reason ?? ""
  } catch {
    // not JSON: a status alone decides
  }
  if (status === 410 || reason === "Unregistered" || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") return "gone"
  return "failed"
}

export class ApnsSender {
  private readonly sessions = new Map<string, ClientHttp2Session>()
  private jwt: { value: string; at: number } | undefined

  constructor(
    private readonly config: ApnsConfig,
    private readonly now: () => number = () => Date.now(),
    /** Overridable for tests; Apple's two hosts otherwise. */
    private readonly hosts: { production: string; sandbox: string } = APNS_HOSTS
  ) {}

  hostFor(device: Pick<PushDevice, "environment">): string {
    return this.hosts[device.environment === "sandbox" ? "sandbox" : "production"]
  }

  /** The provider token, signed again after 50 minutes. */
  async providerToken(): Promise<string> {
    if (this.jwt && this.now() - this.jwt.at < TOKEN_TTL_MS) return this.jwt.value
    const key = await importPKCS8(this.config.privateKey.replace(/\\n/g, "\n"), "ES256")
    const value = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: this.config.keyId }).setIssuer(this.config.teamId).setIssuedAt(Math.floor(this.now() / 1000)).sign(key)
    this.jwt = { value, at: this.now() }
    return value
  }

  async send(device: PushDevice, message: PushMessage): Promise<SendResult> {
    const host = this.hostFor(device)
    const request = apnsRequest(device.token, message, this.config.bundleId)
    const authorization = `bearer ${await this.providerToken()}`
    const { status, body } = await this.post(host, request, authorization)
    return apnsOutcome(status, body)
  }

  private session(host: string): ClientHttp2Session {
    const existing = this.sessions.get(host)
    if (existing && !existing.closed && !existing.destroyed) return existing
    const session = connect(host)
    // A dead connection is dropped and the next send opens a new one; an idle one closes itself.
    session.on("error", () => this.sessions.delete(host))
    session.on("close", () => this.sessions.delete(host))
    session.setTimeout(60_000, () => session.close())
    this.sessions.set(host, session)
    return session
  }

  private post(host: string, request: ApnsRequest, authorization: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const stream = this.session(host).request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: request.path,
        authorization,
        ...request.headers,
      })
      stream.setTimeout(10_000, () => stream.close(constants.NGHTTP2_CANCEL))
      let status = 0
      let body = ""
      stream.setEncoding("utf8")
      stream.on("response", (headers) => (status = Number(headers[constants.HTTP2_HEADER_STATUS])))
      stream.on("data", (chunk: string) => (body += chunk))
      stream.on("end", () => resolve({ status, body }))
      stream.on("error", reject)
      stream.end(request.body)
    })
  }

  close(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}
