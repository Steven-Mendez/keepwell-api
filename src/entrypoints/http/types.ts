import type { Logger } from "../../adapters/observability/logger"

/** What every handler can read from the context, set by the request middleware. */
export interface AppVariables {
  requestId: string
  log: Logger
}

export interface AppEnv {
  Variables: AppVariables
  /** Present only under Lambda (`hono/aws-lambda`); absent in tests and local development. */
  Bindings: { event?: { requestContext?: { requestId?: string } } }
}
