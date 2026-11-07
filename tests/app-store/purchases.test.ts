import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { APPLE_ROOT_CA_G3 } from "../../src/adapters/external/apple/apple-root-ca-g3"
import type { AppStoreVerifier, VerifiedTransaction } from "../../src/core/ports/app-store"
import { adminDatabase, appDatabase } from "../support/database"
import { signIn, testAuthApp } from "../support/auth"
import { wipe } from "../support/sync"

// Apple's library does the cryptography (signature, chain to Apple Root CA G3, bundle id,
// environment). This fake stands in for it with "JWS" strings that are JSON, so everything after
// verification — ours — is what these tests exercise.
const fakeVerifier: AppStoreVerifier = {
  async transaction(signed) {
    const parsed = JSON.parse(signed) as Partial<VerifiedTransaction> & { forged?: boolean }
    if (parsed.forged) throw new Error("bad signature")
    return {
      originalTransactionId: parsed.originalTransactionId!,
      transactionId: parsed.originalTransactionId!,
      productId: parsed.productId ?? "app.keepwell.coffee",
      bundleId: "app.keepwell.ios",
      environment: parsed.environment ?? "Production",
      purchasedAt: new Date("2026-11-01T12:00:00Z"),
      revokedAt: null,
      expiresAt: null,
    }
  },
  async notification(signed) {
    const parsed = JSON.parse(signed) as { uuid: string; type: string; original: string }
    return { notificationUUID: parsed.uuid, type: parsed.type, subtype: null, transaction: await fakeVerifier.transaction(JSON.stringify({ originalTransactionId: parsed.original })) }
  },
}

const coffee = (original: string, extra: Record<string, unknown> = {}) => JSON.stringify({ originalTransactionId: original, ...extra, padding: "x".repeat(20) })

describe("App Store purchases", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(async () => {
    await wipe(admin.db)
    for (const table of ["app_store_transactions", "app_store_notifications", "idempotency_keys"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  const harness = () => testAuthApp(app.db, {}, { appStoreVerifier: fakeVerifier })
  const redeem = (http: ReturnType<typeof harness>["app"], cookie: string, jws: string, key = randomUUID()) =>
    http.request("/entitlements/app-store", { method: "POST", headers: { cookie, "content-type": "application/json", "idempotency-key": key, origin: "http://localhost:3000" }, body: JSON.stringify({ signed_transaction: jws }) })
  const plan = async (http: ReturnType<typeof harness>["app"], cookie: string) => ((await (await http.request("/me", { headers: { cookie } })).json()) as { plan: string; capabilities: string[] })

  it("turns the coffee into supporter and opens the MCP", async () => {
    const { app: http } = harness()
    const { cookie } = await signIn(http, "000001.author")
    const res = await redeem(http, cookie, coffee("otx-1"))
    expect(res.status).toBe(200)
    expect(await plan(http, cookie)).toMatchObject({ plan: "supporter", capabilities: ["cloud_sync", "mcp"] })
  })

  it("answers a retry with the same key from the first answer, and restores without a second grant", async () => {
    const { app: http } = harness()
    const { cookie } = await signIn(http, "000001.author")
    const key = randomUUID()
    await redeem(http, cookie, coffee("otx-1"), key)
    expect((await redeem(http, cookie, coffee("otx-1"), key)).status).toBe(200)
    expect((await redeem(http, cookie, coffee("otx-1"))).status).toBe(200) // restore: new key, same purchase
    expect((await admin.db.execute(sql`select count(*)::int as n from entitlements where reference = 'otx-1'`)).rows).toEqual([{ n: 1 }])
  })

  it("refuses a key reused for a different purchase", async () => {
    const { app: http } = harness()
    const { cookie } = await signIn(http, "000001.author")
    const key = randomUUID()
    await redeem(http, cookie, coffee("otx-1"), key)
    const reused = await redeem(http, cookie, coffee("otx-2"), key)
    expect(reused.status).toBe(422)
  })

  it("refuses the same receipt on a second account, clearly, and records it", async () => {
    const { app: http } = harness()
    const first = await signIn(http, "000001.author")
    await redeem(http, first.cookie, coffee("otx-1"))
    const second = await signIn(http, "000002.second")
    const res = await redeem(http, second.cookie, coffee("otx-1"))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: "already_redeemed_elsewhere" } })
    expect((await plan(http, second.cookie)).plan).toBe("free")
    expect((await admin.db.execute(sql`select count(*)::int as n from audit_log where action = 'purchase.refused'`)).rows).toEqual([{ n: 1 }])
  })

  it("refuses a forged signature, an unknown product, a sandbox purchase in prod, and a missing key", async () => {
    const { app: http } = harness()
    const { cookie } = await signIn(http, "000001.author")
    expect((await redeem(http, cookie, coffee("otx-1", { forged: true }))).status).toBe(400)
    expect((await redeem(http, cookie, coffee("otx-1", { productId: "app.keepwell.other" }))).status).toBe(422)
    expect((await redeem(http, cookie, coffee("otx-1", { environment: "Sandbox" }))).status).toBe(422)
    const noKey = await http.request("/entitlements/app-store", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ signed_transaction: coffee("otx-1") }) })
    expect(noKey.status).toBe(400)
    expect((await plan(http, cookie)).plan).toBe("free")
  })

  it("revokes the plan on a refund notification, once, even if Apple sends it twice", async () => {
    const { app: http } = harness()
    const { cookie } = await signIn(http, "000001.author")
    await redeem(http, cookie, coffee("otx-1"))
    const refund = JSON.stringify({ uuid: randomUUID(), type: "REFUND", original: "otx-1" })
    for (let i = 0; i < 2; i++) {
      const res = await http.request("/webhooks/app-store", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPayload: refund }) })
      expect(res.status).toBe(200)
    }
    expect((await plan(http, cookie)).plan).toBe("free")
    expect((await admin.db.execute(sql`select count(*)::int as n from audit_log where action = 'entitlement.revoked'`)).rows).toEqual([{ n: 1 }])
    expect((await admin.db.execute(sql`select count(*)::int as n from app_store_notifications`)).rows).toEqual([{ n: 1 }])
  })

  it("carries the Apple root certificate byte for byte", () => {
    expect(Buffer.from(APPLE_ROOT_CA_G3, "base64").equals(readFileSync("certs/AppleRootCA-G3.cer"))).toBe(true)
  })
})
