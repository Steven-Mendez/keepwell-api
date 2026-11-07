import { Hono } from "hono"

import type { AppEnv } from "../types"

/** A dependency `GET /health` reports on, such as the database. Each check resolves to "ok" or throws. */
export type HealthCheck = { name: string; run: () => Promise<void> }

export function healthRoutes(options: { version: string; checks: HealthCheck[] }) {
  return new Hono<AppEnv>().get("/health", async (c) => {
    const results: Record<string, "ok" | "error"> = {}
    for (const check of options.checks) {
      try {
        await check.run()
        results[check.name] = "ok"
      } catch (error) {
        results[check.name] = "error"
        c.get("log").error({ err: error, check: check.name }, "health check failed")
      }
    }
    const ok = Object.values(results).every((result) => result === "ok")
    return c.json({ ok, version: options.version, ...results }, ok ? 200 : 503)
  })
}
