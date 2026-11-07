import type { SQSBatchResponse, SQSEvent } from "aws-lambda"

import { DrizzleAccountStore } from "../adapters/database/account-store"
import { DrizzleAuditLog } from "../adapters/database/audit-log"
import { createDatabase, databaseConfigFromEnv } from "../adapters/database/client"
import { createLogger } from "../adapters/observability/logger"
import { DeleteAccountData } from "../core/use-cases/delete-account-data"
import { handleJob } from "./jobs/handle-job"

// The queue consumer Lambda. Partial batch responses: one failing message doesn't redeliver the rest.
const logger = createLogger({ version: process.env.APP_VERSION ?? "unknown" })
const database = databaseConfigFromEnv()
if (!database) throw new Error("DB_HOST is not set")
const { db } = createDatabase(database, logger)
const deleteAccount = new DeleteAccountData(new DrizzleAccountStore(db, logger), new DrizzleAuditLog(db))

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse["batchItemFailures"] = []
  for (const record of event.Records) {
    const log = logger.child({ message_id: record.messageId })
    try {
      await handleJob(record.body, { deleteAccount, log })
    } catch (error) {
      log.error({ err: error, receive_count: record.attributes.ApproximateReceiveCount }, "job failed")
      failures.push({ itemIdentifier: record.messageId })
    }
  }
  return { batchItemFailures: failures }
}
