import { handle } from "hono/aws-lambda"

import { createLogger } from "../adapters/observability/logger"
import { createApp } from "./http/app"

// Module scope runs once per Lambda instance (the cold start); handlers reuse what it builds.
const initStarted = performance.now()
const version = process.env.APP_VERSION ?? "unknown"
const logger = createLogger({ version })
const app = createApp({ logger, version })
const honoHandler = handle(app)
let coldStart = true

export const handler: typeof honoHandler = async (event, context) => {
  if (coldStart) {
    coldStart = false
    logger.info({ cold_start: true, init_ms: Math.round(performance.now() - initStarted) }, "cold start")
  }
  return honoHandler(event, context)
}
