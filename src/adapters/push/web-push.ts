import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes } from "node:crypto"

import { SignJWT } from "jose"

import type { VapidConfig } from "../config/config"
import type { PushDevice, PushMessage, SendResult } from "../../core/ports/push"

// Web Push: VAPID (RFC 8292) to identify the server, aes128gcm content encoding (RFC 8188 / 8291) for
// the payload. Written against node:crypto and jose instead of the `web-push` package, which
// brings an old dependency tree for about eighty lines.

export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export function parseSubscription(token: string): PushSubscriptionJson | undefined {
  try {
    const value = JSON.parse(token) as Partial<PushSubscriptionJson>
    if (typeof value.endpoint === "string" && value.endpoint.startsWith("https://") && typeof value.keys?.p256dh === "string" && typeof value.keys.auth === "string") return value as PushSubscriptionJson
  } catch {
    // falls through
  }
  return undefined
}

/** The page's payload (ADR 0012, "Payloads"): the service worker shows or closes with it. */
export function webPayload(message: PushMessage): { type: "notification"; id: string; title: string; body: string } | { type: "clear"; ids: string[] } {
  return message.type === "clear" ? { type: "clear", ids: message.ids } : { type: "notification", id: message.id, title: message.title, body: message.body }
}

const b64url = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString("base64url")

/**
 * RFC 8291 §3: one record (the payloads are far under 4 KB). `salt` and the sender's key pair are
 * parameters so a test can reproduce a known vector; sending always uses fresh random ones.
 */
export function encryptPayload(
  plaintext: Buffer,
  subscription: { p256dh: string; auth: string },
  random: { salt?: Buffer; senderKey?: ReturnType<typeof createECDH> } = {}
): Buffer {
  const userPublic = Buffer.from(subscription.p256dh, "base64url")
  const authSecret = Buffer.from(subscription.auth, "base64url")
  const sender = random.senderKey ?? createECDH("prime256v1")
  if (!random.senderKey) sender.generateKeys()
  const senderPublic = sender.getPublicKey()
  const salt = random.salt ?? randomBytes(16)

  const shared = sender.computeSecret(userPublic)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), userPublic, senderPublic])
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16))
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12))

  const cipher = createCipheriv("aes-128-gcm", cek, nonce)
  // 0x02 closes the last (here the only) record.
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21 + senderPublic.length)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(senderPublic.length, 20)
  senderPublic.copy(header, 21)
  return Buffer.concat([header, encrypted])
}

/** The VAPID private key (base64url, 32 bytes) as a signing key; the public one gives x and y. */
function vapidKey(config: VapidConfig) {
  const publicKey = Buffer.from(config.publicKey, "base64url")
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", d: config.privateKey, x: b64url(publicKey.subarray(1, 33)), y: b64url(publicKey.subarray(33, 65)) }, format: "jwk" })
}

export async function vapidAuthorization(config: VapidConfig, endpoint: string, nowMs: number): Promise<string> {
  const jwt = await new SignJWT({})
    .setProtectedHeader({ typ: "JWT", alg: "ES256" })
    .setAudience(new URL(endpoint).origin)
    .setSubject(config.subject)
    .setExpirationTime(Math.floor(nowMs / 1000) + 12 * 3600)
    .sign(vapidKey(config))
  return `vapid t=${jwt}, k=${config.publicKey}`
}

/** 404 and 410 mean the subscription is gone (unsubscribed or expired). */
export function webOutcome(status: number): SendResult {
  if (status >= 200 && status < 300) return "sent"
  return status === 404 || status === 410 ? "gone" : "failed"
}

export class WebPushSender {
  constructor(
    private readonly config: VapidConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async send(device: PushDevice, message: PushMessage): Promise<SendResult> {
    const subscription = parseSubscription(device.token)
    // A token that isn't a subscription can never work: treat it as gone.
    if (!subscription) return "gone"
    const body = encryptPayload(Buffer.from(JSON.stringify(webPayload(message))), subscription.keys)
    const response = await this.fetcher(subscription.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization(this.config, subscription.endpoint, this.now()),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        // A notification is worth showing for a day; a clear only matters while it is on screen.
        ttl: message.type === "clear" ? "3600" : "86400",
        urgency: message.type === "clear" ? "low" : "normal",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel().catch(() => undefined)
    return webOutcome(response.status)
  }
}
