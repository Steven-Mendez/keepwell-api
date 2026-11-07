import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"

import type { Auth } from "../../adapters/auth/auth"
import type { Logger } from "../../adapters/observability/logger"
import type { RequestAccountDeletion } from "../../core/use-cases/request-account-deletion"
import type { ResolveCapabilities } from "../../core/use-cases/resolve-capabilities"
import type { SyncRepository } from "../../core/ports/sync-repository"
import { syncRoutes } from "./routes/sync"
import { mcpRoutes, wellKnownRoutes } from "./routes/mcp"
import type { McpConnections } from "../../adapters/auth/mcp-connections"
import type { ReadLedger } from "../../core/use-cases/read-ledger"
import type { CreatePending } from "../../core/use-cases/create-pending"
import type { SwitchesSource } from "../../core/switches"
import type { HandleAppStoreNotification, RedeemPurchase } from "../../core/use-cases/redeem-purchase"
import { appStoreRoutes } from "./routes/app-store"
import { openApiDocument } from "./openapi"
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
  requestDeletion?: Promise<RequestAccountDeletion>
  capabilities?: Promise<ResolveCapabilities>
  sync?: SyncRepository
  clock?: () => number
  switches?: SwitchesSource
  appStore?: { redeem: Promise<RedeemPurchase>; notifications: Promise<HandleAppStoreNotification> }
  /** The MCP server's data access; with it, /mcp is mounted. */
  mcp?: { readLedger: ReadLedger; baseURL: string; now?: () => Date; connections?: McpConnections; createPending?: CreatePending }
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
  app.get("/openapi.json", (c) => c.json(openApiDocument()))
  if (deps.auth) {
    app.route("/", authRoutes(deps.auth))
    app.route("/", meRoutes(deps.auth, { requestDeletion: deps.requestDeletion, capabilities: deps.capabilities }))
    if (deps.capabilities && deps.sync) {
      app.route("/", syncRoutes({ auth: deps.auth, capabilities: deps.capabilities, repository: deps.sync, clock: deps.clock, switches: deps.switches }))
    }
    if (deps.appStore) app.route("/", appStoreRoutes({ auth: deps.auth, ...deps.appStore }))
    if (deps.capabilities && deps.mcp) {
      app.route("/", wellKnownRoutes(deps.auth, deps.mcp.baseURL))
      app.route("/", mcpRoutes({ auth: deps.auth, capabilities: deps.capabilities, switches: deps.switches, ...deps.mcp }))
    }
  }
  return app
}

export type App = ReturnType<typeof createApp>
