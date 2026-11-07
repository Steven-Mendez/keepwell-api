import type { MiddlewareHandler } from "hono"

/** The API serves JSON only, so the headers are the strict set with nothing to relax. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Referrer-Policy", "no-referrer")
    c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store")
  }
}
