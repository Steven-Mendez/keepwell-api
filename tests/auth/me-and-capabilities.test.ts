import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { CachedPlansSource } from "../../src/adapters/config/plans-source"
import { CLOSED_PLANS } from "../../src/core/capabilities"
import { onError } from "../../src/entrypoints/http/errors"
import { requireCapability } from "../../src/entrypoints/http/middlewares/capability"
import type { AppEnv } from "../../src/entrypoints/http/types"
import { adminDatabase, appDatabase } from "../support/database"
import { captureLogger } from "../support/logger"
import { LAUNCH_PLANS, signIn, testAuthApp } from "../support/auth"

describe("GET /me with plans and capabilities", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(async () => {
    for (const table of ["sessions", "accounts", "users", "audit_log", "entitlements"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  it("answers a free account with sync from early access", async () => {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    const res = await http.request("/me", { headers: { cookie } })
    expect(await res.json()).toMatchObject({ plan: "free", capabilities: ["cloud_sync"], early_access: ["cloud_sync"] })
    expect(res.headers.get("cache-control")).toBe("private, max-age=300")
  })

  it("changes the answer when the parameter changes, with no deploy", async () => {
    let plans = LAUNCH_PLANS
    const { app: http } = testAuthApp(app.db, {}, { plans: () => plans })
    const { cookie } = await signIn(http, "000001.author")
    plans = CLOSED_PLANS
    expect(await (await http.request("/me", { headers: { cookie } })).json()).toMatchObject({ plan: "free", capabilities: [] })
  })

  it("shows supporter after a manual grant", async () => {
    const { app: http, entitlements } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    const userId = ((await (await http.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await entitlements.grant(userId, { plan: "supporter", source: "manual" })
    expect(await (await http.request("/me", { headers: { cookie } })).json()).toMatchObject({ plan: "supporter", capabilities: ["cloud_sync", "mcp"] })
  })

  it("refuses a missing capability with 403 needs_plan, after authentication", async () => {
    const { app: http, capabilities } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    const userId = ((await (await http.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    const route = new Hono<AppEnv>()
    route.onError(onError)
    route.use(async (c, next) => {
      c.set("requestId", "r")
      c.set("log", captureLogger().logger)
      c.set("user", { id: userId, name: "", email: "" })
      await next()
    })
    route.get("/mcp", requireCapability(capabilities, "mcp"), (c) => c.text("ok"))
    const res = await route.request("/mcp")
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: "needs_plan", details: { capability: "mcp" } } })
  })
})

describe("plans parameter cache", () => {
  it("reloads after the TTL, keeps the last good value on a bad read, and starts closed", async () => {
    const { logger } = captureLogger()
    let clock = 0
    let text = JSON.stringify(LAUNCH_PLANS)
    const source = new CachedPlansSource(async () => text, logger, 60_000, () => clock)
    expect(await source.current()).toEqual(LAUNCH_PLANS)
    text = JSON.stringify(CLOSED_PLANS)
    expect(await source.current()).toEqual(LAUNCH_PLANS)
    clock = 60_001
    expect(await source.current()).toEqual(CLOSED_PLANS)
    text = "not json"
    clock = 200_000
    expect(await source.current()).toEqual(CLOSED_PLANS)
    const broken = new CachedPlansSource(async () => "{}", logger)
    expect(await broken.current()).toEqual(CLOSED_PLANS)
  })
})
