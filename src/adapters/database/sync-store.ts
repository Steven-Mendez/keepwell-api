import type { Logger } from "../observability/logger"
import type { Database } from "./client"
import { ScopedSyncRepository } from "./repositories/sync-repository"
import { scopedDb } from "./scoped-db"
import { withTransaction } from "./with-transaction"

/** Wires the sync repository to the database: the one place that hands it a transaction. */
export function createSyncRepository(db: Database, log: Logger) {
  return new ScopedSyncRepository(
    (userId) => scopedDb(db, userId),
    (userId, work) => withTransaction(db, log, (tx) => work(scopedDb(tx, userId), tx as never))
  )
}
