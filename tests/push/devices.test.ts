import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { CLOSED_PLANS } from "../../src/core/capabilities"
import { adminDatabase, appDatabase } from "../support/database"
import { signIn, testAuthApp } from "../support/auth"
import { wipe } from "../support/sync"

const IOS = { platform: "ios", token: "ab".repeat(32), time_zone: "America/Managua", locale: "es-NI", environment: "sandbox" }
const WEB = { platform: "web", token: JSON.stringify({ endpoint: "https://push.example.com/send/abc", keys: { p256dh: "BCVx", auth: "BTBZ" } }), time_zone: "Europe/Madrid", locale: "es-ES" }

describe("push device routes", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function setup(options: Parameters<typeof testAuthApp>[2] = {}, sub = "000001.author") {
    const built = testAuthApp(app.db, {}, options)
    const { cookie } = await signIn(built.app, sub)
    const headers = { cookie, "content-type": "application/json", origin: "http://localhost:3000" }
    const put = (clientId: string, body: unknown) => built.app.request(`/push/devices/${clientId}`, { method: "PUT", headers, body: JSON.stringify(body) })
    const rows = async () => (await admin.db.execute(sql`select client_id, platform, token, time_zone, locale, environment from push_devices order by client_id`)).rows
    return { ...built, cookie, headers, put, rows }
  }

  it("registers a device, refreshes it under the same client id and keeps one row", async () => {
    const { put, rows } = await setup()
    const clientId = randomUUID()
    expect((await put(clientId, IOS)).status).toBe(204)
    expect(await rows()).toEqual([{ client_id: clientId, platform: "ios", token: IOS.token, time_zone: "America/Managua", locale: "es-NI", environment: "sandbox" }])
    // The token rotates and the person travels.
    expect((await put(clientId, { ...IOS, token: "cd".repeat(32), time_zone: "Asia/Tokyo", environment: undefined })).status).toBe(204)
    expect(await rows()).toEqual([{ client_id: clientId, platform: "ios", token: "cd".repeat(32), time_zone: "Asia/Tokyo", locale: "es-NI", environment: "production" }])
  })

  it("stores a web subscription without an environment", async () => {
    const { put, rows } = await setup()
    const clientId = randomUUID()
    expect((await put(clientId, WEB)).status).toBe(204)
    expect(await rows()).toEqual([expect.objectContaining({ client_id: clientId, platform: "web", token: WEB.token, environment: null })])
  })

  it("removes a device, and answers 204 when there is none", async () => {
    const { put, rows, headers, app: http } = await setup()
    const clientId = randomUUID()
    await put(clientId, IOS)
    const gone = await http.request(`/push/devices/${clientId}`, { method: "DELETE", headers })
    expect(gone.status).toBe(204)
    expect(await rows()).toEqual([])
    expect((await http.request(`/push/devices/${clientId}`, { method: "DELETE", headers })).status).toBe(204)
  })

  it("only touches the caller's devices", async () => {
    const mine = await setup({}, "000001.author")
    const clientId = randomUUID()
    await mine.put(clientId, IOS)
    const other = testAuthApp(app.db)
    const { cookie } = await signIn(other.app, "000002.second")
    const res = await other.app.request(`/push/devices/${clientId}`, { method: "DELETE", headers: { cookie, origin: "http://localhost:3000" } })
    expect(res.status).toBe(204)
    expect(await mine.rows()).toHaveLength(1)
    // The same client id under another account is its own device.
    await other.app.request(`/push/devices/${clientId}`, { method: "PUT", headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify(IOS) })
    expect(await mine.rows()).toHaveLength(2)
  })

  it.each([
    ["an unknown platform", { ...IOS, platform: "android" }],
    ["a time zone that doesn't exist", { ...IOS, time_zone: "Mars/Olympus" }],
    ["a locale that isn't BCP 47", { ...IOS, locale: "not a locale!" }],
    ["an iOS token that isn't lowercase hex", { ...IOS, token: "XYZ" }],
    ["a web token that isn't a subscription", { ...WEB, token: "nope" }],
    ["an unknown environment", { ...IOS, environment: "staging" }],
    ["no body", undefined],
  ])("rejects %s with 400", async (_, body) => {
    const { put } = await setup()
    const res = await put(randomUUID(), body)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } })
  })

  it("rejects a client id that isn't a UUID", async () => {
    const { put } = await setup()
    expect((await put("not-a-uuid", IOS)).status).toBe(400)
  })

  it("needs a session, and the cloud_sync capability", async () => {
    const { app: http, headers } = await setup()
    const id = randomUUID()
    expect((await http.request(`/push/devices/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(IOS) })).status).toBe(401)
    expect((await http.request("/push/config")).status).toBe(401)
    const closed = await setup({ plans: () => CLOSED_PLANS }, "000002.second")
    const res = await closed.put(id, IOS)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: "needs_plan", details: { capability: "cloud_sync" } } })
    expect((await closed.app.request("/push/config", { headers: closed.headers })).status).toBe(403)
    void headers
  })

  it("serves the VAPID public key, or 503 when web push isn't configured", async () => {
    const on = await setup({ vapidPublicKey: "BPublicKey_base64url" })
    const res = await on.app.request("/push/config", { headers: on.headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ vapid_public_key: "BPublicKey_base64url" })
    const off = await setup({}, "000002.second")
    const missing = await off.app.request("/push/config", { headers: off.headers })
    expect(missing.status).toBe(503)
    expect(await missing.json()).toMatchObject({ error: { code: "push_unavailable" } })
  })
})
