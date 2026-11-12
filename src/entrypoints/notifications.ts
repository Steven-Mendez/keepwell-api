import { configSourceFromEnv, loadConfig } from "../adapters/config/config"
import { createDatabase, databaseConfigFromEnv } from "../adapters/database/client"
import { DrizzlePushStore } from "../adapters/database/push-store"
import { ScopedLedgerReader } from "../adapters/database/repositories/ledger-reader"
import { scopedDb } from "../adapters/database/scoped-db"
import { createSyncRepository } from "../adapters/database/sync-store"
import { createLogger } from "../adapters/observability/logger"
import { createPushSender } from "../adapters/push/create"
import { ApplySyncBatch } from "../core/use-cases/apply-sync-batch"
import { ReadLedger } from "../core/use-cases/read-ledger"
import { SendDueNotifications, type SendSummary } from "../core/use-cases/send-due-notifications"

// The scheduled notifications Lambda (ADR 0012): EventBridge Scheduler invokes it every 15 minutes.
// Calendar math for the ledger's recurring occurrences follows the same zone as the API; each
// person's notifications are computed in their device's zone (core/notifications/time-zone.ts).
process.env.TZ = process.env.KEEPWELL_TIME_ZONE ?? "America/Managua"

const logger = createLogger({ version: process.env.APP_VERSION ?? "unknown" })
const database = databaseConfigFromEnv()
if (!database) throw new Error("DB_HOST is not set")
const { db } = createDatabase(database, logger)
const store = new DrizzlePushStore(db, logger)

let job: Promise<SendDueNotifications> | undefined
function build(): Promise<SendDueNotifications> {
  return (job ??= loadConfig(configSourceFromEnv()).then((config) => {
    const ledger = new ReadLedger(new ScopedLedgerReader((userId) => scopedDb(db, userId)), new ApplySyncBatch(createSyncRepository(db, logger)))
    return new SendDueNotifications({ devices: store, deliveries: store, ledger, sender: createPushSender(config, { local: false, logger }), log: logger })
  }))
}

export async function handler(): Promise<SendSummary> {
  let summary: SendSummary
  try {
    summary = await (await build()).execute()
  } catch (error) {
    // Configuration that failed to load is retried by the next invocation.
    job = undefined
    throw error
  }
  // Every person failing means something systemic (database, permissions): surface it to the alarm.
  if (summary.users > 0 && summary.userErrors === summary.users) throw new Error(`notifications failed for all ${summary.users} users`)
  return summary
}
