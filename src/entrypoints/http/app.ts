import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

import type { Logger } from "../../adapters/observability/logger"
import { ApiError, errorBody, onError } from "./errors"
import { requestContext } from "./middlewares/request-context"
import { securityHeaders } from "./middlewares/security-headers"
import { healthRoutes, type HealthCheck } from "./routes/health"
import type { AppEnv } from "./types"

/** 1 MB, checked here because an HTTP API can't be configured below 10 MB. */
export const MAX_BODY_BYTES = 1024 * 1024

export interface AppDependencies {
  logger: Logger
  version: string
  healthChecks?: HealthCheck[]
}

/** Builds the whole HTTP surface from its dependencies, so tests and Lambda wire the same app. */
export function createApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>()
  app.use(requestContext(deps.logger))
  app.use(securityHeaders())
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
  return app
}

export type App = ReturnType<typeof createApp>
