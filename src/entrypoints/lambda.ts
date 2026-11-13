import { handle } from "hono/aws-lambda"

import { databaseConfigFromEnv } from "../adapters/database/client"
import { createLogger } from "../adapters/observability/logger"
import { bootstrap } from "./bootstrap"

// Module scope runs once per Lambda instance (the cold start); handlers reuse what it builds.
const initStarted = performance.now()
const version = process.env.APP_VERSION ?? "unknown"
const logger = createLogger({ version })
const database = databaseConfigFromEnv()
if (!database) throw new Error("DB_HOST is not set")
const app = bootstrap({ logger, version, database })
const honoHandler = handle(app)

// Top-level await keeps the init phase open until the database, configuration, Better Auth and
// Apple's keys are ready, so the first request finds them warm (under provisioned concurrency that
// happens before any traffic). Bounded, and a failure is only logged: the requests retry lazily.
await Promise.race([app.warmUp(), new Promise((resolve) => setTimeout(resolve, 6_000).unref())]).catch((error: unknown) =>
  logger.warn({ err: error }, "warm-up failed")
)
let coldStart = true

export const handler: typeof honoHandler = async (event, context) => {
  if (coldStart) {
    coldStart = false
    logger.info({ cold_start: true, init_ms: Math.round(performance.now() - initStarted) }, "cold start")
  }
  return honoHandler(event, context)
}
