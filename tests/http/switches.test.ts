import { randomUUID } from "node:crypto"

import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { CachedSwitchesSource } from "../../src/adapters/config/plans-source"
import { NORMAL_SWITCHES, type Switches } from "../../src/core/switches"
import { adminDatabase, appDatabase } from "../support/database"
import { captureLogger } from "../support/logger"
import { mcpClient } from "../support/mcp"
import { signIn, testAuthApp } from "../support/auth"
import { categoryRow, event, syncClient, wipe } from "../support/sync"

describe("emergency switches", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  it("read_only refuses pushes with 503 and keeps pulls working, and turning it off restores writes", async () => {
    let switches: Switches = { ...NORMAL_SWITCHES, read_only: true }
    const { app: http } = testAuthApp(app.db, {}, { switches: () => switches })
    const { cookie } = await signIn(http, "000001.author")
    const client = syncClient(http, cookie)
    const blocked = await client.push([event("category", categoryRow("groceries", "Super", "2026-11-01T10:00:00.000Z"), "create")])
    expect(blocked.status).toBe(503)
    expect((await client.pull(0)).status).toBe(200)
    switches = NORMAL_SWITCHES
    expect((await client.push([event("category", categoryRow("groceries", "Super", "2026-11-01T10:00:00.000Z"), "create")])).status).toBe(200)
  })

  it("mcp_enabled false refuses every MCP request, whoever asks", async () => {
    const { app: http, entitlements } = testAuthApp(app.db, {}, { switches: () => ({ ...NORMAL_SWITCHES, mcp_enabled: false }) })
    const { cookie } = await signIn(http, "000001.author")
    const userId = ((await (await http.request("/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id
    await entitlements.grant(userId, { plan: "supporter", source: "manual" })
    const res = await mcpClient(http, { cookie }).initialize()
    expect(res.status).toBe(503)
    expect(String(res.body)).toContain("mcp_disabled")
    // Sync is untouched.
    expect((await syncClient(http, cookie).pull(0)).status).toBe(200)
    expect(randomUUID()).toBeTruthy()
  })

  it("rereads the parameter after 30 seconds, and a broken value means normal operation", async () => {
    const { logger } = captureLogger()
    let clock = 0
    let text = JSON.stringify({ mcp_enabled: true, read_only: true })
    const source = new CachedSwitchesSource(async () => text, logger, 30_000, () => clock)
    expect((await source.current()).read_only).toBe(true)
    text = JSON.stringify(NORMAL_SWITCHES)
    clock = 30_001
    expect((await source.current()).read_only).toBe(false)
    expect(await new CachedSwitchesSource(async () => "{", logger).current()).toEqual(NORMAL_SWITCHES)
  })
})
