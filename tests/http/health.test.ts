import { describe, expect, it } from "vitest"

import { createApp } from "../../src/entrypoints/http/app"
import { captureLogger } from "../support/logger"

describe("GET /health", () => {
  it("answers ok with the deployed version", async () => {
    const { logger } = captureLogger()
    const res = await createApp({ logger, version: "abc123" }).request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: "abc123" })
  })

  it("reports each dependency and fails with 503 when one is down", async () => {
    const { logger } = captureLogger()
    const app = createApp({
      logger,
      version: "v",
      healthChecks: [
        { name: "db", run: async () => {} },
        { name: "config", run: async () => Promise.reject(new Error("unreachable")) },
      ],
    })
    const res = await app.request("/health")
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, version: "v", db: "ok", config: "error" })
  })

  it("stamps a request id on the response and on every log line", async () => {
    const { logger, lines } = captureLogger()
    const res = await createApp({ logger, version: "v" }).request("/health")
    const id = res.headers.get("x-request-id")
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(lines.find((line) => line.msg === "request")).toMatchObject({ request_id: id, status: 200, route: "/health" })
  })

  it("ignores a request id sent by the client", async () => {
    const { logger } = captureLogger()
    const res = await createApp({ logger, version: "v" }).request("/health", { headers: { "x-request-id": "forged" } })
    expect(res.headers.get("x-request-id")).not.toBe("forged")
  })

  it("sends the security headers", async () => {
    const { logger } = captureLogger()
    const res = await createApp({ logger, version: "v" }).request("/health")
    expect(res.headers.get("strict-transport-security")).toContain("max-age=")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  })
})

describe("errors", () => {
  it("answers unknown routes with the error shape", async () => {
    const { logger } = captureLogger()
    const res = await createApp({ logger, version: "v" }).request("/nope")
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string }; request_id: string }
    expect(body.error.code).toBe("not_found")
    expect(body.request_id).toBe(res.headers.get("x-request-id"))
  })

  it("rejects bodies over 1 MB before any handler runs", async () => {
    const { logger } = captureLogger()
    const res = await createApp({ logger, version: "v" }).request("/health", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
      headers: { "content-length": String(1024 * 1024 + 1) },
    })
    expect(res.status).toBe(413)
  })
})
