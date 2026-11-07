import type { Logger } from "../../adapters/observability/logger"

/** The signed-in person, as the session middleware resolves it. */
export interface SessionUser {
  id: string
  name: string
  email: string
}

/** What every handler can read from the context, set by the middlewares. */
export interface AppVariables {
  requestId: string
  log: Logger
  user: SessionUser
  sessionId: string
}

export interface AppEnv {
  Variables: AppVariables
  /** Present only under Lambda (`hono/aws-lambda`); absent in tests and local development. */
  Bindings: { event?: { requestContext?: { requestId?: string; http?: { sourceIp?: string } } } }
}
