import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { DrizzlePushStore } from "../../src/adapters/database/push-store"
import { adminDatabase, appDatabase } from "../support/database"
import { captureLogger } from "../support/logger"
import { wipe } from "../support/sync"

const NOW = new Date("2026-11-13T10:00:00Z")
const ios = (clientId: string, token = "ab".repeat(32)) => ({ clientId, platform: "ios" as const, token, timeZone: "UTC", locale: "en", environment: "production" as const })

describe("DrizzlePushStore", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))
  const store = () => new DrizzlePushStore(app.db, captureLogger().logger)

  it("lists a person's devices and the people who have any", async () => {
    const s = store()
    await s.upsert("u1", ios("c1"), NOW)
    await s.upsert("u1", ios("c2", "cd".repeat(32)), NOW)
    await s.upsert("u2", ios("c1"), NOW)
    expect((await s.list("u1")).map((d) => d.clientId).sort()).toEqual(["c1", "c2"])
    expect((await s.usersWithDevices()).sort()).toEqual(["u1", "u2"])
  })

  it("keeps one device per token: the same subscription under a new installation id replaces the old row, only for that person", async () => {
    const s = store()
    await s.upsert("u1", ios("old"), NOW)
    await s.upsert("u1", ios("other", "cd".repeat(32)), NOW)
    await s.upsert("u2", ios("theirs"), NOW)
    await s.upsert("u1", ios("new"), NOW)
    expect((await s.list("u1")).map((d) => d.clientId).sort()).toEqual(["new", "other"])
    expect((await s.list("u2")).map((d) => d.clientId)).toEqual(["theirs"])
  })

  it("claims a delivery once, even when two runs race, and lets a released one be claimed again", async () => {
    const s = store()
    const results = await Promise.all(Array.from({ length: 5 }, () => s.claim("u1", "cutoff:x:2026-11-13", NOW)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await s.claim("u2", "cutoff:x:2026-11-13", NOW)).toBe(true)
    await s.release("u1", "cutoff:x:2026-11-13")
    expect(await s.claim("u1", "cutoff:x:2026-11-13", NOW)).toBe(true)
  })

  it("prunes deliveries older than the cut-off, for everyone", async () => {
    const s = store()
    await s.claim("u1", "old", new Date("2026-06-01T00:00:00Z"))
    await s.claim("u2", "old", new Date("2026-06-01T00:00:00Z"))
    await s.claim("u1", "new", NOW)
    expect(await s.prune(new Date("2026-07-01T00:00:00Z"))).toBe(2)
    expect(await s.claim("u1", "new", NOW)).toBe(false)
    expect(await s.claim("u1", "old", NOW)).toBe(true)
  })

  it("removes a device with its token only while the token is still the one it holds", async () => {
    const s = store()
    await s.upsert("u1", ios("c1", "ab".repeat(32)), NOW)
    await s.removeWithToken("u1", "c1", "cd".repeat(32))
    expect(await s.list("u1")).toHaveLength(1)
    await s.removeWithToken("u1", "c1", "ab".repeat(32))
    expect(await s.list("u1")).toHaveLength(0)
  })
})
