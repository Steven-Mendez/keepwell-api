import { handle } from "hono/aws-lambda"

import { createDatabase, databaseConfigFromEnv } from "../adapters/db/client"
import { pingDatabase } from "../adapters/db/health"
import { createLogger } from "../adapters/observability/logger"
import { createApp } from "./http/app"
import type { HealthCheck } from "./http/routes/health"

// Module scope runs once per Lambda instance (the cold start); handlers reuse what it builds.
const initStarted = performance.now()
const version = process.env.APP_VERSION ?? "unknown"
const logger = createLogger({ version })

const healthChecks: HealthCheck[] = []
const dbConfig = databaseConfigFromEnv()
if (dbConfig) {
  const { db } = createDatabase(dbConfig, logger)
  healthChecks.push({ name: "db", run: () => pingDatabase(db) })
}

const app = createApp({ logger, version, healthChecks })
const honoHandler = handle(app)
let coldStart = true

export const handler: typeof honoHandler = async (event, context) => {
  if (coldStart) {
    coldStart = false
    logger.info({ cold_start: true, init_ms: Math.round(performance.now() - initStarted) }, "cold start")
  }
  return honoHandler(event, context)
}
