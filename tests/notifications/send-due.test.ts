import { beforeEach, describe, expect, it } from "vitest"

import { GONE_GRACE_MS } from "../../src/core/ports/push"
import { ClearReadNotifications } from "../../src/core/use-cases/clear-read-notifications"
import { DELIVERY_RETENTION_DAYS, MAX_PER_USER_RUN, SendDueNotifications } from "../../src/core/use-cases/send-due-notifications"
import { fakeLedger, ledger, MemoryStores, RecordingSender, silentLog, stateRow, VISA } from "../support/notifications"

const NOW = new Date("2026-11-13T10:00:00Z") // 19:00 in Tokyo, 02:00 in Los Angeles
const CUTOFF = `cutoff:${VISA}:2026-11-13`
const PAYMENT = `payment:${VISA}:2026-11-15`
const BUDGET = "budget:groceries:2026-11:near"
/** The ledger as ReadLedger hands it over: read in the person's zone (here Tokyo's, like their device). */
const tokyo = (extra: Parameters<typeof ledger>[0] = {}) => ledger({ ...extra, timeZone: "Asia/Tokyo" })

describe("SendDueNotifications", () => {
  let stores: MemoryStores
  let sender: RecordingSender
  const job = (now = NOW, value = tokyo(), states: Parameters<typeof fakeLedger>[1] = []) => new SendDueNotifications({ devices: stores, deliveries: stores, ledger: fakeLedger(value, states), sender, log: silentLog, clock: () => now })

  beforeEach(() => {
    stores = new MemoryStores()
    sender = new RecordingSender()
  })

  it("sends what is due once, in the person's zone, and not again on the next run", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en-US", environment: "production" }, NOW)
    const first = await job().execute()
    expect(sender.notifications.map((c) => (c.message as { id: string }).id).sort()).toEqual([BUDGET, CUTOFF, PAYMENT].sort())
    expect(first).toMatchObject({ users: 1, sent: 3, failed: 0 })
    // 15 minutes later: nothing new.
    sender.calls = []
    expect(await job(new Date(NOW.getTime() + 15 * 60_000)).execute()).toMatchObject({ sent: 0 })
    expect(sender.calls).toEqual([])
  })

  it("holds dated notifications until 09:00 local but sends budget ones at once", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "America/Los_Angeles", locale: "en", environment: "production" }, NOW)
    const losAngeles = ledger({ timeZone: "America/Los_Angeles" })
    await job(NOW, losAngeles).execute()
    expect(sender.notifications.map((c) => (c.message as { id: string }).id)).toEqual([BUDGET])
    // Seven hours later it is 09:00 in Los Angeles.
    sender.calls = []
    await job(new Date("2026-11-13T17:00:00Z"), losAngeles).execute()
    expect(sender.notifications.map((c) => (c.message as { id: string }).id).sort()).toEqual([CUTOFF, PAYMENT].sort())
  })

  it("words each device in its own language and puts the unread count in the badge", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en-US", environment: "production" }, NOW)
    await stores.upsert("user-1", { clientId: "c2", platform: "web", token: "{}", timeZone: "Asia/Tokyo", locale: "es-NI", environment: null }, new Date(NOW.getTime() - 1000))
    await job().execute()
    const payment = sender.notifications.filter((c) => (c.message as { id: string }).id === PAYMENT)
    expect(payment).toHaveLength(2)
    const en = payment.find((c) => c.device.clientId === "c1")!.message
    const es = payment.find((c) => c.device.clientId === "c2")!.message
    expect(en).toMatchObject({ title: "Visa: payment in 2 days", kind: "payment", target: { screen: "creditCard", accountId: VISA }, badge: 3 })
    expect((es as { title: string }).title).not.toBe((en as { title: string }).title)
  })

  it("skips what was read or deleted on another device", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    await job(NOW, tokyo(), [stateRow(CUTOFF, { read_at: "2026-11-13T09:00:00Z" }), stateRow(PAYMENT, { dismissed_at: "2026-11-13T09:00:00Z" })]).execute()
    expect(sender.notifications.map((c) => (c.message as { id: string }).id)).toEqual([BUDGET])
  })

  it("releases a delivery that failed everywhere, so the next run retries it", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    sender.outcomes.set("c1", "failed")
    expect(await job().execute()).toMatchObject({ sent: 0, failed: 3 })
    expect(stores.deliveries.size).toBe(0)
    sender.outcomes.clear()
    expect(await job().execute()).toMatchObject({ sent: 3, failed: 0 })
    expect(stores.deliveries.size).toBe(3)
  })

  it("keeps a delivery that reached at least one device", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    await stores.upsert("user-1", { clientId: "c2", platform: "web", token: "{}", timeZone: "Asia/Tokyo", locale: "en", environment: null }, new Date(NOW.getTime() - 1000))
    sender.outcomes.set("c2", "failed")
    expect(await job().execute()).toMatchObject({ sent: 3, failed: 0 })
  })

  it("deletes a device the push service says is gone, and stops sending to it", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    await stores.upsert("user-1", { clientId: "c2", platform: "web", token: "{}", timeZone: "Asia/Tokyo", locale: "en", environment: null }, new Date(NOW.getTime() - GONE_GRACE_MS))
    sender.outcomes.set("c2", "gone")
    const summary = await job().execute()
    expect(summary.devicesRemoved).toBe(1)
    expect((await stores.list("user-1")).map((d) => d.clientId)).toEqual(["c1"])
    // c2 was asked once (for the first notification), never again.
    expect(sender.calls.filter((c) => c.device.clientId === "c2")).toHaveLength(1)
    expect(sender.calls.filter((c) => c.device.clientId === "c1")).toHaveLength(3)
  })

  it("keeps a device that registered within the last hour even if it is called gone, but stops sending to it this run", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    await stores.upsert("user-1", { clientId: "c2", platform: "web", token: "{}", timeZone: "Asia/Tokyo", locale: "en", environment: null }, new Date(NOW.getTime() - GONE_GRACE_MS + 60_000))
    sender.outcomes.set("c2", "gone")
    const summary = await job().execute()
    expect(summary.devicesRemoved).toBe(0)
    expect((await stores.list("user-1")).map((d) => d.clientId).sort()).toEqual(["c1", "c2"])
    expect(sender.calls.filter((c) => c.device.clientId === "c2")).toHaveLength(1)
  })

  it("never double-sends when two runs overlap", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    await Promise.all([job().execute(), job().execute()])
    const ids = sender.notifications.map((c) => (c.message as { id: string }).id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(3)
  })

  it("computes in the person's home zone, whatever zone their devices are in", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    await job(NOW, ledger({ timeZone: "America/Los_Angeles" })).execute()
    // 02:00 in Los Angeles (19:00 on the Tokyo phone): only the budget one.
    expect(sender.notifications.map((c) => (c.message as { id: string }).id)).toEqual([BUDGET])
  })

  it("caps a run so a new device on an old ledger isn't flooded", async () => {
    const drafts = Array.from({ length: MAX_PER_USER_RUN + 5 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      date: "2026-11-10T12:00:00.000Z",
      status: "planned" as const,
      description: `Draft ${i}`,
      kind: "expense" as const,
      amount: "5",
      currency: "USD",
      accountId: VISA,
      exchangeRate: { principal: "USD", second: "USD", rate: "1" },
      isShared: false,
    }))
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    await job(NOW, tokyo({ transactions: [...drafts, ...ledger().transactions] })).execute()
    expect(sender.notifications).toHaveLength(MAX_PER_USER_RUN)
    const planned = sender.notifications.find((c) => c.message.type === "notification" && c.message.kind === "planned")!.message
    expect(planned).toMatchObject({ transactionId: expect.stringMatching(/^00000000-/) })
  })

  it("keeps going when one person fails, and prunes deliveries older than 120 days", async () => {
    await stores.upsert("user-1", { clientId: "c1", platform: "ios", token: "ab".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    await stores.upsert("user-2", { clientId: "c2", platform: "ios", token: "cd".repeat(32), timeZone: "Asia/Tokyo", locale: "en", environment: "production" }, NOW)
    const failing = new SendDueNotifications({
      devices: stores,
      deliveries: stores,
      ledger: { load: async (userId: string) => (userId === "user-1" ? Promise.reject(new Error("db down")) : fakeLedger(tokyo()).load(userId)) } as never,
      sender,
      log: silentLog,
      clock: () => NOW,
    })
    expect(await failing.execute()).toMatchObject({ users: 2, userErrors: 1, sent: 3 })
    expect(stores.pruned[0]!.getTime()).toBe(NOW.getTime() - DELIVERY_RETENTION_DAYS * 86_400_000)
  })

  it("does nothing for a person without devices", async () => {
    expect(await job().execute()).toMatchObject({ users: 0, sent: 0 })
  })
})

describe("ClearReadNotifications", () => {
  it("clears the other devices, not the one that read it, with the new badge", async () => {
    const stores = new MemoryStores()
    const sender = new RecordingSender()
    for (const [clientId, platform] of [["a", "ios"], ["b", "ios"], ["c", "web"]] as const) {
      await stores.upsert("user-1", { clientId, platform, token: platform === "ios" ? "ab".repeat(32) : "{}", timeZone: "Asia/Tokyo", locale: "en", environment: platform === "ios" ? "production" : null }, NOW)
    }
    const clear = new ClearReadNotifications({ devices: stores, ledger: fakeLedger(tokyo(), [stateRow(CUTOFF, { read_at: "x" })]), sender, log: silentLog, clock: () => NOW })
    await clear.execute({ userId: "user-1", clientId: "a", ids: [CUTOFF] })
    expect(sender.calls.map((c) => c.device.clientId).sort()).toEqual(["b", "c"])
    expect(sender.calls[0]!.message).toEqual({ type: "clear", ids: [CUTOFF], badge: 2 })
  })

  it("never throws, and drops a device that is gone", async () => {
    const stores = new MemoryStores()
    const sender = new RecordingSender()
    await stores.upsert("user-1", { clientId: "a", platform: "ios", token: "ab".repeat(32), timeZone: "UTC", locale: "en", environment: "production" }, NOW)
    await stores.upsert("user-1", { clientId: "b", platform: "ios", token: "cd".repeat(32), timeZone: "UTC", locale: "en", environment: "production" }, new Date(NOW.getTime() - GONE_GRACE_MS))
    sender.outcomes.set("b", "gone")
    const clear = new ClearReadNotifications({ devices: stores, ledger: fakeLedger(tokyo()), sender, log: silentLog, clock: () => NOW })
    await clear.execute({ userId: "user-1", clientId: "a", ids: ["x"] })
    expect((await stores.list("user-1")).map((d) => d.clientId)).toEqual(["a"])
    const broken = new ClearReadNotifications({ devices: stores, ledger: { load: async () => Promise.reject(new Error("db")) } as never, sender, log: silentLog })
    await expect(broken.execute({ userId: "user-1", clientId: "zzz", ids: ["x"] })).resolves.toBeUndefined()
  })
})
