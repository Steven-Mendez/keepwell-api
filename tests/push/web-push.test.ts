import { createDecipheriv, createECDH, hkdfSync } from "node:crypto"

import { importJWK, jwtVerify } from "jose"
import { describe, expect, it } from "vitest"

import { encryptPayload, parseSubscription, vapidAuthorization, WebPushSender, webOutcome, webPayload } from "../../src/adapters/push/web-push"
import { device } from "../support/notifications"

const b64 = (bytes: Buffer) => bytes.toString("base64url")

/** The browser's side of RFC 8291, to check what the server encrypts can be read. */
function decrypt(body: Buffer, user: { ecdh: ReturnType<typeof createECDH>; auth: Buffer }): string {
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const senderPublic = body.subarray(21, 21 + idLength)
  const ciphertext = body.subarray(21 + idLength)
  const shared = user.ecdh.computeSecret(senderPublic)
  const ikm = Buffer.from(hkdfSync("sha256", shared, user.auth, Buffer.concat([Buffer.from("WebPush: info\0"), user.ecdh.getPublicKey(), senderPublic]), 32))
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16))
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12))
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  expect(plain.at(-1)).toBe(2)
  return plain.subarray(0, plain.length - 1).toString()
}

function browser() {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  const auth = Buffer.from("0123456789abcdef")
  const subscription = { endpoint: "https://push.example.com/send/abc", keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } }
  return { ecdh, auth, subscription }
}

describe("Web Push payloads (ADR 0012, Payloads)", () => {
  it("shapes the notification and the clear exactly as the service worker reads them", () => {
    expect(webPayload({ type: "notification", id: "cutoff:x:2026-11-13", kind: "cutoff", title: "T", body: "B", target: { screen: "summary" }, badge: 2 })).toEqual({ type: "notification", id: "cutoff:x:2026-11-13", title: "T", body: "B" })
    expect(webPayload({ type: "clear", ids: ["a", "b"], badge: 0 })).toEqual({ type: "clear", ids: ["a", "b"] })
  })

  it("matches the RFC 8291 test vector (appendix A)", () => {
    const sender = createECDH("prime256v1")
    sender.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"))
    const body = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), senderKey: sender }
    )
    expect(b64(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    )
  })

  it("encrypts so the subscribed browser can read it", () => {
    const user = browser()
    const text = JSON.stringify({ type: "clear", ids: ["a"] })
    expect(decrypt(encryptPayload(Buffer.from(text), user.subscription.keys), user)).toBe(text)
  })

  it("reads a subscription from the stored token, refusing anything that isn't one", () => {
    const { subscription } = browser()
    expect(parseSubscription(JSON.stringify(subscription))).toEqual(subscription)
    expect(parseSubscription("not json")).toBeUndefined()
    expect(parseSubscription(JSON.stringify({ endpoint: "http://insecure", keys: subscription.keys }))).toBeUndefined()
    expect(parseSubscription(JSON.stringify({ endpoint: subscription.endpoint }))).toBeUndefined()
  })

  it("maps 404 and 410 to gone", () => {
    expect([201, 200, 404, 410, 429, 500].map(webOutcome)).toEqual(["sent", "sent", "gone", "gone", "failed", "failed"])
  })
})

describe("WebPushSender", () => {
  const vapid = createECDH("prime256v1")
  vapid.generateKeys()
  const config = { publicKey: b64(vapid.getPublicKey()), privateKey: b64(vapid.getPrivateKey()), subject: "mailto:author@example.com" }

  it("signs the VAPID header with the audience of the push service", async () => {
    const header = await vapidAuthorization(config, "https://push.example.com/send/abc", Date.parse("2026-11-13T10:00:00Z"))
    const [, jwt, key] = /^vapid t=(.+), k=(.+)$/.exec(header)!.slice(0) as unknown as [string, string, string]
    expect(key).toBe(config.publicKey)
    const publicKey = vapid.getPublicKey()
    const verified = await jwtVerify(jwt, await importJWK({ kty: "EC", crv: "P-256", x: b64(publicKey.subarray(1, 33)), y: b64(publicKey.subarray(33, 65)) }, "ES256"), { currentDate: new Date("2026-11-13T10:00:00Z") })
    expect(verified.payload).toMatchObject({ aud: "https://push.example.com", sub: "mailto:author@example.com", exp: Date.parse("2026-11-13T10:00:00Z") / 1000 + 43200 })
  })

  it("posts the encrypted payload with the push headers and reads the status", async () => {
    const user = browser()
    const calls: { url: string; init: RequestInit }[] = []
    let status = 201
    const sender = new WebPushSender(config, () => Date.parse("2026-11-13T10:00:00Z"), (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status })
    }) as unknown as typeof fetch)
    const target = device({ platform: "web", token: JSON.stringify(user.subscription) })

    expect(await sender.send(target, { type: "notification", id: "cutoff:x:2026-11-13", kind: "cutoff", title: "Title", body: "Body", target: { screen: "summary" }, badge: 1 })).toBe("sent")
    const call = calls[0]!
    expect(call.url).toBe(user.subscription.endpoint)
    const headers = call.init.headers as Record<string, string>
    expect(headers["content-encoding"]).toBe("aes128gcm")
    expect(headers["authorization"]).toMatch(/^vapid t=.+, k=/)
    expect(headers["ttl"]).toBe("86400")
    expect(JSON.parse(decrypt(Buffer.from(call.init.body as Uint8Array), user))).toEqual({ type: "notification", id: "cutoff:x:2026-11-13", title: "Title", body: "Body" })

    await sender.send(target, { type: "clear", ids: ["a"], badge: 0 })
    expect(JSON.parse(decrypt(Buffer.from(calls[1]!.init.body as Uint8Array), user))).toEqual({ type: "clear", ids: ["a"] })

    status = 410
    expect(await sender.send(target, { type: "clear", ids: ["a"], badge: 0 })).toBe("gone")
    status = 503
    expect(await sender.send(target, { type: "clear", ids: ["a"], badge: 0 })).toBe("failed")
    expect(await sender.send(device({ platform: "web", token: "garbage" }), { type: "clear", ids: ["a"], badge: 0 })).toBe("gone")
  })
})
