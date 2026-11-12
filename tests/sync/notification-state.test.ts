import { randomUUID } from "node:crypto"

import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { GONE_GRACE_MS } from "../../src/core/ports/push"
import { adminDatabase, appDatabase } from "../support/database"
import { signIn, testAuthApp } from "../support/auth"
import { categoryRow, event, syncClient, transactionRow, wipe } from "../support/sync"

const NOW = new Date("2026-11-13T18:00:00Z")
const T0 = "2026-11-01T10:00:00.000Z"
const T1 = "2026-11-01T11:00:00.000Z"
const T2 = "2026-11-01T12:00:00.000Z"
const ID = "budget:groceries:2026-11:near"

const state = (id: string, extra: Record<string, unknown> = {}) => ({ id, read_at: null, dismissed_at: null, created_at: T0, updated_at: T0, deleted_at: null, ...extra })
const ios = (clientId: string) => ({ clientId, platform: "ios" as const, token: `${clientId.replace(/-/g, "")}${"ab".repeat(16)}`.slice(0, 64), timeZone: "America/Managua", locale: "en", environment: "production" as const })

describe("notificationState sync (ADR 0012)", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function setup() {
    const built = testAuthApp(app.db, {}, { now: () => NOW })
    const { cookie } = await signIn(built.app, "000001.author")
    const userId = ((await (await built.app.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    return { ...built, cookie, userId }
  }

  it("round-trips through push, pull and snapshot, last writer wins, and a tombstone is final", async () => {
    const { app: http, cookie } = await setup()
    const phone = syncClient(http, cookie)
    const web = syncClient(http, cookie)
    const first = await phone.push([event("notificationState", state(ID, { read_at: T1, updated_at: T1 }), "create")])
    expect(first.body.results[0]).toMatchObject({ status: "applied" })
    expect((await web.pull(0)).body.changes).toMatchObject([{ entity: "notificationState", entity_id: ID, row: { read_at: T1, dismissed_at: null } }])

    // "Mark as unread" from the web, later: it wins.
    await web.push([event("notificationState", state(ID, { read_at: null, updated_at: T2 }), "update")])
    // An older write that arrives late is stale and gets the server's row back.
    const stale = await phone.push([event("notificationState", state(ID, { read_at: T1, dismissed_at: T1, updated_at: T1 }), "update")])
    expect(stale.body.results[0]).toMatchObject({ status: "stale", current: { read_at: null } })
    expect((await web.snapshot("notificationState")).body.rows).toMatchObject([{ id: ID, read_at: null, dismissed_at: null }])

    // Pruned by a client: final.
    await web.push([event("notificationState", state(ID, { updated_at: T2, deleted_at: T2 }), "delete")])
    const revived = await phone.push([event("notificationState", state(ID, { read_at: T2, updated_at: "2026-11-01T13:00:00.000Z" }), "update")])
    expect(revived.body.results[0]).toMatchObject({ status: "stale", reason: "tombstone_is_final" })
  })

  it("rejects an id over 64 characters", async () => {
    const { app: http, cookie } = await setup()
    const result = await syncClient(http, cookie).push([event("notificationState", state("x".repeat(65)), "create")])
    expect(result.body.results[0]).toMatchObject({ status: "rejected" })
  })
})

describe("silent clear after a sync push", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function setup() {
    const built = testAuthApp(app.db, {}, { now: () => NOW })
    const { cookie } = await signIn(built.app, "000001.author")
    const userId = ((await (await built.app.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    const pushing = syncClient(built.app, cookie)
    const other = randomUUID()
    const third = randomUUID()
    await built.pushStore.upsert(userId, ios(pushing.clientId), NOW)
    await built.pushStore.upsert(userId, ios(other), NOW)
    await built.pushStore.upsert(userId, { ...ios(third), platform: "web", token: "{}", environment: null }, NOW)
    return { ...built, cookie, userId, pushing, other, third }
  }

  it("tells the other devices, not the one that pushed, to clear what was read or deleted, with the new badge", async () => {
    const { pushSender, pushing, other, third } = await setup()
    // A groceries budget at 85%: one unread notification (the budget one).
    await pushing.push([event("category", { ...categoryRow("groceries", "Groceries", T0), budget_amount: "100", budget_currency: "USD" }, "create"), event("transaction", transactionRow(randomUUID(), "2026-11-12T12:00:00.000Z", { amount: "85" }), "create")])
    expect(pushSender.sent).toEqual([])

    // Deleting some other notification leaves the budget one unread: the badge still counts it.
    await pushing.push([event("notificationState", state("price:other", { dismissed_at: T1, read_at: T1, updated_at: T1 }), "create")])
    expect(pushSender.sent.map((s) => s.message)).toEqual([{ type: "clear", ids: ["price:other"], badge: 1 }, { type: "clear", ids: ["price:other"], badge: 1 }])

    // Reading the budget one takes it to zero.
    pushSender.sent.length = 0
    await pushing.push([event("notificationState", state(ID, { read_at: T1, updated_at: T1 }), "create")])
    expect(pushSender.sent.map((s) => s.device.clientId).sort()).toEqual([other, third].sort())
    for (const { message } of pushSender.sent) expect(message).toEqual({ type: "clear", ids: [ID], badge: 0 })
  })

  it("does nothing when the change leaves the notification unread, is stale, or isn't about notifications", async () => {
    const { pushSender, pushing } = await setup()
    await pushing.push([event("notificationState", state(ID, { read_at: null, updated_at: T1 }), "create")])
    await pushing.push([event("category", categoryRow("groceries", "Groceries", T0), "create")])
    // Read at T2, then a stale "dismissed" from T0 that loses.
    await pushing.push([event("notificationState", state("price:t1", { read_at: T2, updated_at: T2 }), "create")])
    pushSender.sent.length = 0
    await pushing.push([event("notificationState", state("price:t1", { dismissed_at: T0, updated_at: T0 }), "update")])
    expect(pushSender.sent).toEqual([])
  })

  it("answers the push even when sending throws, and forgets devices the service says are gone", async () => {
    const { app: http, pushSender, pushStore, userId, pushing, other, cookie } = await setup()
    // Registered over an hour ago: a `gone` from a just-made subscription isn't believed yet.
    await pushStore.upsert(userId, ios(other), new Date(NOW.getTime() - GONE_GRACE_MS))
    pushSender.outcomes.set(other, "gone")
    const result = await pushing.push([event("notificationState", state(ID, { dismissed_at: T1, read_at: T1, updated_at: T1 }), "create")])
    expect(result.status).toBe(200)
    expect(result.body.results[0]).toMatchObject({ status: "applied" })
    expect((await pushStore.list(userId)).map((d) => d.clientId)).not.toContain(other)

    pushSender.send = async () => {
      throw new Error("push service down")
    }
    const again = await syncClient(http, cookie, pushing.clientId).push([event("notificationState", state("price:t9", { read_at: T1, updated_at: T1 }), "create")])
    expect(again.status).toBe(200)
    expect(again.body.results[0]).toMatchObject({ status: "applied" })
  })

  it("sends nothing when the person has no other device", async () => {
    const built = testAuthApp(app.db, {}, { now: () => NOW })
    const { cookie } = await signIn(built.app, "000002.second")
    const client = syncClient(built.app, cookie)
    const result = await client.push([event("notificationState", state(ID, { read_at: T1, updated_at: T1 }), "create")])
    expect(result.body.results[0]).toMatchObject({ status: "applied" })
    expect(built.pushSender.sent).toEqual([])
  })
})
