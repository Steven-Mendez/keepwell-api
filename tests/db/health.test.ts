import { afterAll, describe, expect, it } from "vitest"

import { pingDatabase } from "../../src/adapters/db/health"
import { createApp } from "../../src/entrypoints/http/app"
import { appDatabase } from "../support/database"
import { captureLogger } from "../support/logger"

describe("GET /health with a database", () => {
  const app = appDatabase()
  afterAll(() => app.close())

  it("answers db: ok after a round trip", async () => {
    const { logger } = captureLogger()
    const res = await createApp({ logger, version: "v", healthChecks: [{ name: "db", run: () => pingDatabase(app.db) }] }).request("/health")
    expect(await res.json()).toEqual({ ok: true, version: "v", db: "ok" })
  })
})
