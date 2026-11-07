import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"

import type { Auth } from "../../adapters/auth/auth"
import type { Logger } from "../../adapters/observability/logger"
import { ApiError, errorBody, onError } from "./errors"
import { requestContext } from "./middlewares/request-context"
import { securityHeaders } from "./middlewares/security-headers"
import { authRoutes } from "./routes/auth"
import { healthRoutes, type HealthCheck } from "./routes/health"
import { meRoutes } from "./routes/me"
import type { AppEnv } from "./types"

/** 1 MB, checked here because an HTTP API can't be configured below 10 MB. */
export const MAX_BODY_BYTES = 1024 * 1024

export interface AppDependencies {
  logger: Logger
  version: string
  healthChecks?: HealthCheck[]
  /** Built once configuration has loaded; routes that need it wait for it. */
  auth?: Promise<Auth>
  /** The only origin allowed by CORS, with credentials. No wildcards. */
  webOrigin?: string
}

/** Builds the whole HTTP surface from its dependencies, so tests and Lambda wire the same app. */
export function createApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>()
  app.use(requestContext(deps.logger))
  app.use(securityHeaders())
  if (deps.webOrigin) {
    app.use(
      cors({
        origin: deps.webOrigin,
        credentials: true,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["content-type", "idempotency-key"],
        exposeHeaders: ["x-request-id"],
        maxAge: 600,
      })
    )
  }
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new ApiError(413, "payload_too_large", "The request body is larger than 1 MB")
      },
    })
  )
  app.onError(onError)
  app.notFound((c) => c.json(errorBody(c, "not_found", "No such route"), 404))

  app.route("/", healthRoutes({ version: deps.version, checks: deps.healthChecks ?? [] }))
  if (deps.auth) {
    app.route("/", authRoutes(deps.auth))
    app.route("/", meRoutes(deps.auth))
  }
  return app
}

export type App = ReturnType<typeof createApp>
