import { generateKeyPairSync } from "node:crypto"
import { createServer, type Http2Server } from "node:http2"
import type { AddressInfo } from "node:net"

import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose"
import { afterEach, describe, expect, it } from "vitest"

import { APNS_HOSTS, ApnsSender, apnsOutcome, apnsRequest, collapseId } from "../../src/adapters/push/apns"
import { device } from "../support/notifications"

const alert = {
  type: "notification" as const,
  id: "payment:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:2026-11-15",
  kind: "payment",
  title: "Visa: payment in 2 days",
  body: "Pay before day 15 so it doesn't generate interest.",
  target: { screen: "creditCard" as const, accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  badge: 3,
}

describe("APNs payloads (ADR 0012, Payloads)", () => {
  it("builds the alert: aps.alert, sound, thread-id, badge, collapse id, notification_id and target", () => {
    const request = apnsRequest("ab".repeat(32), { ...alert, id: "cutoff:x:2026-11-13", kind: "cutoff" }, "app.keepwell.ios")
    expect(request.path).toBe(`/3/device/${"ab".repeat(32)}`)
    expect(request.headers).toEqual({ "apns-topic": "app.keepwell.ios", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "cutoff:x:2026-11-13" })
    expect(JSON.parse(request.body)).toEqual({
      aps: { alert: { title: alert.title, body: alert.body }, sound: "default", "thread-id": "cutoff", badge: 3 },
      notification_id: "cutoff:x:2026-11-13",
      target: alert.target,
    })
  })

  it("hashes a notification id longer than 64 bytes into the collapse id (SHA-256 hex, first 64)", () => {
    const long = { ...alert, id: `budget:${"a-long-custom-category-slug-".repeat(3)}:2026-11:near` }
    expect(Buffer.byteLength(long.id)).toBeGreaterThan(64)
    const id = collapseId(long.id)
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(id).toBe(collapseId(long.id))
    expect(collapseId(alert.id)).toBe(alert.id)
    expect(apnsRequest("t", long, "x").headers["apns-collapse-id"]).toBe(id)
    // The custom key keeps the full id.
    expect(JSON.parse(apnsRequest("t", long, "x").body).notification_id).toBe(long.id)
  })

  it("adds the planned category and the uppercase transaction id to drafts", () => {
    const draft = { ...alert, id: "planned:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "planned", target: { screen: "transaction" as const, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, transactionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
    const body = JSON.parse(apnsRequest("t", draft, "x").body)
    expect(body.aps.category).toBe("keepwell.planned")
    expect(body.transactionID).toBe("BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB")
  })

  it("builds the silent clear: background, priority 5, content-available, clear_ids and badge", () => {
    const request = apnsRequest("t", { type: "clear", ids: ["a", "b"], badge: 1 }, "app.keepwell.ios")
    expect(request.headers).toEqual({ "apns-topic": "app.keepwell.ios", "apns-push-type": "background", "apns-priority": "5" })
    expect(JSON.parse(request.body)).toEqual({ aps: { "content-available": 1, badge: 1 }, clear_ids: ["a", "b"] })
  })

  it("maps 410 and BadDeviceToken to gone, other errors to failed", () => {
    expect(apnsOutcome(200, "")).toBe("sent")
    expect(apnsOutcome(410, '{"reason":"Unregistered"}')).toBe("gone")
    expect(apnsOutcome(400, '{"reason":"BadDeviceToken"}')).toBe("gone")
    expect(apnsOutcome(400, '{"reason":"PayloadEmpty"}')).toBe("failed")
    expect(apnsOutcome(429, '{"reason":"TooManyRequests"}')).toBe("failed")
    expect(apnsOutcome(500, "")).toBe("failed")
  })
})

describe("ApnsSender", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const config = { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), keyId: "ABC123DEFG", teamId: "TEAM000000", bundleId: "app.keepwell.ios" }
  let server: Http2Server | undefined
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())))

  it("signs an ES256 provider token with the key id and team, and caches it for 50 minutes", async () => {
    let now = Date.parse("2026-11-13T10:00:00Z")
    const sender = new ApnsSender(config, () => now)
    const token = await sender.providerToken()
    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "ABC123DEFG" })
    const { payload } = await jwtVerify(token, await importSPKI(publicKey.export({ type: "spki", format: "pem" }).toString(), "ES256"), { currentDate: new Date(now) })
    expect(payload).toMatchObject({ iss: "TEAM000000", iat: now / 1000 })
    now += 49 * 60_000
    expect(await sender.providerToken()).toBe(token)
    now += 2 * 60_000
    expect(await sender.providerToken()).not.toBe(token)
  })

  it("posts over HTTP/2 with the token, picks the sandbox host by the device's environment and reads the answer", async () => {
    const seen: { path: string; headers: Record<string, unknown>; body: string }[] = []
    server = createServer()
    server.on("stream", (stream, headers) => {
      let body = ""
      stream.setEncoding("utf8")
      stream.on("data", (chunk: string) => (body += chunk))
      stream.on("end", () => {
        seen.push({ path: String(headers[":path"]), headers, body })
        const gone = String(headers[":path"]).includes("dead")
        stream.respond({ ":status": gone ? 410 : 200 })
        stream.end(gone ? '{"reason":"Unregistered"}' : "")
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const sender = new ApnsSender(config, undefined, { production: url, sandbox: url })
    expect(await sender.send(device({ token: "ab".repeat(32) }), alert)).toBe("sent")
    expect(seen[0]!.path).toBe(`/3/device/${"ab".repeat(32)}`)
    expect(seen[0]!.headers["authorization"]).toMatch(/^bearer ey/)
    expect(seen[0]!.headers["apns-topic"]).toBe("app.keepwell.ios")
    expect(seen[0]!.headers[":method"]).toBe("POST")
    expect(JSON.parse(seen[0]!.body).aps.badge).toBe(3)
    expect(await sender.send(device({ token: "dead" }), alert)).toBe("gone")
    sender.close()
  })

  it("uses Apple's sandbox host for development builds and production for the rest", () => {
    expect(APNS_HOSTS).toEqual({ production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" })
    const sender = new ApnsSender(config)
    expect(sender.hostFor(device({ environment: "sandbox" }))).toBe(APNS_HOSTS.sandbox)
    expect(sender.hostFor(device({ environment: "production" }))).toBe(APNS_HOSTS.production)
    expect(sender.hostFor(device({ environment: null }))).toBe(APNS_HOSTS.production)
  })
})
