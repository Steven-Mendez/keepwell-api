import { randomUUID } from "node:crypto"
import type { MiddlewareHandler } from "hono"

import type { Logger } from "../../../adapters/observability/logger"
import { runWithRequest } from "../../../adapters/observability/request-context"
import type { AppEnv } from "../types"

/**
 * Gives each request an id and a child logger that stamps it on every line, and returns the id in
 * `x-request-id` so a person reporting an error can quote it. Under Lambda the id is API Gateway's,
 * which ties our lines to the access log; a client-sent id is never trusted. The id, source IP and
 * user agent are also available to adapters (the audit log) for the duration of the request.
 */
export function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.env?.event?.requestContext?.requestId ?? randomUUID()
    const log = logger.child({ request_id: requestId })
    c.set("requestId", requestId)
    c.set("log", log)
    const ip = c.env?.event?.requestContext?.http?.sourceIp ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    const started = performance.now()
    await runWithRequest({ requestId, ip, userAgent: c.req.header("user-agent") ?? null }, () => next())
    c.header("x-request-id", requestId)
    log.info(
      {
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        duration_ms: Math.round(performance.now() - started),
      },
      "request"
    )
  }
}
