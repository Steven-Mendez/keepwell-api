import { Hono } from "hono"

import type { Auth } from "../../../adapters/auth/auth"
import type { AppEnv } from "../types"

/**
 * Better Auth answers everything under /api/auth with web-standard Request/Response.
 *
 * The OAuth callback is a page the browser lands on, not an API call: when it fails (not invited,
 * an invalid invitation, a stale state) Better Auth answers JSON, which the person would see raw.
 * Those answers become a redirect to the web's sign-in page with the error code, which it explains.
 */
export function authRoutes(auth: Promise<Auth>, options: { webOrigin?: string; before?: () => Promise<void> } = {}) {
  return new Hono<AppEnv>().on(["GET", "POST"], "/api/auth/*", async (c) => {
    const handler = await auth
    await options.before?.()
    const response = await handler.handler(c.req.raw)
    if (!options.webOrigin || !c.req.path.startsWith("/api/auth/callback/") || response.status < 400) return response
    const body = (await response.clone().json().catch(() => undefined)) as { code?: string } | undefined
    const code = body?.code && /^[A-Z_]{1,64}$/.test(body.code) ? body.code : "SIGN_IN_FAILED"
    c.get("log").warn({ code, status: response.status }, "sign-in callback failed")
    return c.redirect(`${options.webOrigin}/login?error=${code}`, 302)
  })
}
