import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { bootstrap } from "../../src/entrypoints/bootstrap"
import { captureLogger } from "../support/logger"

describe("a deploy whose secrets aren't set yet", () => {
  const unhandled: unknown[] = []
  const record = (reason: unknown) => unhandled.push(reason)
  afterEach(() => {
    process.off("unhandledRejection", record)
  })

  it("stays up and says config: error instead of crashing", async () => {
    process.on("unhandledRejection", record)
    const dir = mkdtempSync(join(tmpdir(), "keepwell-config-"))
    const file = join(dir, "config.json")
    writeFileSync(file, JSON.stringify({ auth_secret: "unset" }))
    const { logger } = captureLogger()
    const app = bootstrap({
      logger,
      version: "test",
      database: { kind: "postgres", url: process.env.DATABASE_URL ?? "postgres://keepwell:keepwell@localhost:54329/keepwell", maxConnections: 1 },
      env: { CONFIG_FILE: file, API_BASE_URL: "http://localhost:3001", WEB_ORIGIN: "http://localhost:3000" },
    })
    const res = await app.request("/health")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, config: "error" })
    expect(unhandled).toEqual([])
  })
})
