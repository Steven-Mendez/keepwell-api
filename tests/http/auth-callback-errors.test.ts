import { Hono } from "hono"
import { describe, expect, it } from "vitest"

import type { Auth } from "../../src/adapters/auth/auth"
import { authRoutes } from "../../src/entrypoints/http/routes/auth"
import type { AppEnv } from "../../src/entrypoints/http/types"
import { captureLogger } from "../support/logger"

const answering = (status: number, body: unknown) =>
  Promise.resolve({ handler: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) } as unknown as Auth)

const mount = (auth: Promise<Auth>) => {
  const { logger } = captureLogger()
  return new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("log", logger)
      await next()
    })
    .route("/", authRoutes(auth, { webOrigin: "https://app.example.com" }))
}

describe("Apple callback errors", () => {
  it("turn a refusal into the web's sign-in page with its code", async () => {
    const res = await mount(answering(403, { code: "NOT_INVITED", message: "invite-only" })).request("/api/auth/callback/apple")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://app.example.com/login?error=NOT_INVITED")
  })

  it("never echo an unexpected code into the URL", async () => {
    const res = await mount(answering(500, { code: "<script>" })).request("/api/auth/callback/apple")
    expect(res.headers.get("location")).toBe("https://app.example.com/login?error=SIGN_IN_FAILED")
  })

  it("leave API calls (not the callback) as JSON for the apps", async () => {
    const res = await mount(answering(403, { code: "NOT_INVITED" })).request("/api/auth/sign-in/social", { method: "POST" })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: "NOT_INVITED" })
  })
})
