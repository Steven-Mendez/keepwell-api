import { appleClientSecret } from "../adapters/external/apple/client-secret"
import { createAuth, type Auth } from "../adapters/auth/auth"
import { configSourceFromEnv, loadConfig, type AppConfig } from "../adapters/config/config"
import { DrizzleAuditLog } from "../adapters/database/audit-log"
import { createDatabase, type Database, type DatabaseConfig } from "../adapters/database/client"
import { pingDatabase } from "../adapters/database/health"
import type { Logger } from "../adapters/observability/logger"
import { createApp } from "./http/app"
import type { HealthCheck } from "./http/routes/health"

export interface Urls {
  /** This API's public URL. */
  apiBaseUrl: string
  /** The web app's origin. */
  webOrigin: string
  /** Registrable domain for the shared session cookie; unset in local development. */
  cookieDomain?: string
}

export function urlsFromEnv(env: NodeJS.ProcessEnv = process.env): Urls {
  return {
    apiBaseUrl: env.API_BASE_URL ?? "http://localhost:3001",
    webOrigin: env.WEB_ORIGIN ?? "http://localhost:3000",
    cookieDomain: env.COOKIE_DOMAIN || undefined,
  }
}

/** Everything that depends on configuration, built once it has loaded. */
export async function buildAuth(db: Database, config: AppConfig, urls: Urls): Promise<Auth> {
  const secret = await appleClientSecret({
    teamId: config.apple_team_id,
    keyId: config.apple_key_id,
    servicesId: config.apple_services_id,
    privateKey: config.apple_private_key,
  })
  return createAuth({
    db,
    config,
    audit: new DrizzleAuditLog(db),
    baseURL: urls.apiBaseUrl,
    webOrigin: urls.webOrigin,
    cookieDomain: urls.cookieDomain,
    appleClientSecret: secret,
  })
}

/**
 * Wires the app from the environment, once per process (a Lambda instance, or `pnpm dev`).
 * Configuration loads in the background; a failure is logged and reported by /health instead of
 * crashing the instance, so the reason is visible from outside.
 */
export function bootstrap(options: { logger: Logger; version: string; database: DatabaseConfig; env?: NodeJS.ProcessEnv }) {
  const { logger, version } = options
  const urls = urlsFromEnv(options.env)
  const { db } = createDatabase(options.database, logger)

  const config: Promise<AppConfig> = loadConfig(configSourceFromEnv(options.env))
  const auth = config.then((loaded) => buildAuth(db, loaded, urls))
  auth.catch((error: unknown) => logger.error({ err: error }, "configuration failed to load"))

  const healthChecks: HealthCheck[] = [
    { name: "db", run: () => pingDatabase(db) },
    { name: "config", run: async () => void (await auth) },
  ]
  return createApp({ logger, version, healthChecks, auth, webOrigin: urls.webOrigin })
}
