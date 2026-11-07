import { configSourceFromEnv, loadConfig, type AppConfig } from "../adapters/config/config"
import { createDatabase, type DatabaseConfig } from "../adapters/db/client"
import { pingDatabase } from "../adapters/db/health"
import type { Logger } from "../adapters/observability/logger"
import { createApp } from "./http/app"
import type { HealthCheck } from "./http/routes/health"

/**
 * Wires the app from the environment, once per process (a Lambda instance, or `pnpm dev`).
 * Configuration loads in the background; a failure is logged and reported by /health instead of
 * crashing the instance, so the reason is visible from outside.
 */
export function bootstrap(options: { logger: Logger; version: string; database?: DatabaseConfig; env?: NodeJS.ProcessEnv }) {
  const { logger, version } = options
  const healthChecks: HealthCheck[] = []

  if (options.database) {
    const { db } = createDatabase(options.database, logger)
    healthChecks.push({ name: "db", run: () => pingDatabase(db) })
  }

  const config: Promise<AppConfig> = loadConfig(configSourceFromEnv(options.env))
  config.catch((error: unknown) => logger.error({ err: error }, "configuration failed to load"))
  healthChecks.push({ name: "config", run: async () => void (await config) })

  return createApp({ logger, version, healthChecks })
}
