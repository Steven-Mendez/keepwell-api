import { appleClientSecret } from "../adapters/external/apple/client-secret"
import { createAuth, type Auth } from "../adapters/auth/auth"
import { configSourceFromEnv, loadConfig, type AppConfig } from "../adapters/config/config"
import { DrizzleAccountStore } from "../adapters/database/account-store"
import { DrizzleAuditLog } from "../adapters/database/audit-log"
import { DrizzleEntitlementRepository } from "../adapters/database/entitlements"
import { createSyncRepository } from "../adapters/database/sync-store"
import { ScopedLedgerReader } from "../adapters/database/repositories/ledger-reader"
import { scopedDb } from "../adapters/database/scoped-db"
import { ApplySyncBatch } from "../core/use-cases/apply-sync-batch"
import { AppleAppStoreVerifier } from "../adapters/external/apple/app-store"
import { DrizzlePurchaseStore } from "../adapters/database/purchase-store"
import { HandleAppStoreNotification, RedeemPurchase } from "../core/use-cases/redeem-purchase"
import { McpConnections } from "../adapters/auth/mcp-connections"
import { ChangeLogWriteCounter } from "../adapters/database/repositories/mcp-write-counter"
import { CreatePending } from "../core/use-cases/create-pending"
import { ReadLedger } from "../core/use-cases/read-ledger"
import { CachedPlansSource, CachedSwitchesSource, filePlansLoader, ssmPlansLoader } from "../adapters/config/plans-source"
import { ResolveCapabilities } from "../core/use-cases/resolve-capabilities"
import { createDatabase, type Database, type DatabaseConfig } from "../adapters/database/client"
import { pingDatabase } from "../adapters/database/health"
import type { Logger } from "../adapters/observability/logger"
import { InlineJobQueue, SqsJobQueue } from "../adapters/queue/sqs-job-queue"
import type { JobQueue } from "../core/ports/job-queue"
import { DeleteAccountData } from "../core/use-cases/delete-account-data"
import { RequestAccountDeletion } from "../core/use-cases/request-account-deletion"
import { createApp } from "./http/app"
import { DrizzleInvitationStore } from "../adapters/database/invitation-store"
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
/**
 * Marks a promise built from the configuration as handled. With configuration missing (a fresh
 * deploy before its secrets are set) every such promise rejects; unhandled, Node ends the process
 * and /health can't say `config: error`. Routes that await it still get the rejection.
 */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  return promise
}

export function bootstrap(options: { logger: Logger; version: string; database: DatabaseConfig; env?: NodeJS.ProcessEnv }) {
  const { logger, version } = options
  const urls = urlsFromEnv(options.env)
  const { db } = createDatabase(options.database, logger)

  const config: Promise<AppConfig> = loadConfig(configSourceFromEnv(options.env))
  const auth = config.then((loaded) => buildAuth(db, loaded, urls))
  auth.catch((error: unknown) => logger.error({ err: error }, "configuration failed to load"))

  // Under Lambda the queue is SQS; locally the job runs in-process right after the request.
  const accounts = new DrizzleAccountStore(db, logger)
  const audit = new DrizzleAuditLog(db)
  const env = options.env ?? process.env
  const queue: JobQueue = env.QUEUE_URL
    ? new SqsJobQueue(env.QUEUE_URL)
    : new InlineJobQueue((job) => new DeleteAccountData(accounts, audit).execute(job.userId))
  const requestDeletion = quiet(auth.then(() => new RequestAccountDeletion(accounts, queue, audit)))
  const plansLoader = env.CONFIG_PREFIX ? ssmPlansLoader(`${env.CONFIG_PREFIX}/capabilities`) : filePlansLoader(env.CONFIG_FILE ?? "config.local.json")
  const switches = new CachedSwitchesSource(
    env.CONFIG_PREFIX ? ssmPlansLoader(`${env.CONFIG_PREFIX}/switches`) : filePlansLoader(env.CONFIG_FILE ?? "config.local.json", "switches"),
    logger
  )
  const capabilities = Promise.resolve(new ResolveCapabilities(new DrizzleEntitlementRepository(db), new CachedPlansSource(plansLoader, logger)))

  const sync = createSyncRepository(db, logger)
  const writer = new ApplySyncBatch(sync)
  const readLedger = new ReadLedger(new ScopedLedgerReader((userId) => scopedDb(db, userId)), writer)
  const mcp = {
    readLedger,
    baseURL: urls.apiBaseUrl,
    connections: new McpConnections(db, audit),
    createPending: new CreatePending({ ledger: readLedger, writer, counter: new ChangeLogWriteCounter((userId) => scopedDb(db, userId)) }),
  }

  // The coffee (increment 23): productId → plan from the environment, Apple's bundle id from config.
  const products = JSON.parse(env.APP_STORE_PRODUCTS ?? "{}") as Record<string, string>
  const acceptSandbox = env.APP_STORE_SANDBOX === "true"
  const purchases = new DrizzlePurchaseStore(db, logger)
  const verifier = quiet(config).then(
    (loaded) => new AppleAppStoreVerifier({ bundleId: loaded.apple_bundle_id, appAppleId: env.APP_STORE_APP_ID ? Number(env.APP_STORE_APP_ID) : undefined, acceptSandbox })
  )
  const appStore = {
    redeem: quiet(verifier.then((v) => new RedeemPurchase(v, purchases, audit, products, acceptSandbox))),
    notifications: quiet(verifier.then((v) => new HandleAppStoreNotification(v, purchases, audit))),
  }

  const invitations = { store: new DrizzleInvitationStore(db), secure: urls.apiBaseUrl.startsWith("https://"), cookieDomain: urls.cookieDomain }

  const healthChecks: HealthCheck[] = [
    { name: "db", run: () => pingDatabase(db) },
    { name: "config", run: async () => void (await auth) },
  ]
  return createApp({ logger, version, healthChecks, auth, webOrigin: urls.webOrigin, requestDeletion, capabilities, sync, mcp, switches, appStore, invitations })
}
