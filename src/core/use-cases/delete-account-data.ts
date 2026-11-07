import type { AccountStore } from "../ports/account-store"
import type { AuditLog } from "../ports/audit-log"

/** Rows per batch: well under DSQL's 3,000 modified rows per transaction. */
export const DELETE_BATCH = 1_000

/**
 * The deletion job. Erases a marked account in batches, each its own transaction, until nothing is
 * left. Idempotent: running it again on a half-erased or fully erased account finishes the job or
 * does nothing. Refuses accounts that were never marked, so a stray message can't erase anyone.
 */
export class DeleteAccountData {
  constructor(
    private readonly accounts: AccountStore,
    private readonly audit: AuditLog
  ) {}

  async execute(userId: string): Promise<{ deletedRows: number; status: "deleted" | "not_marked" }> {
    if (!(await this.accounts.isMarkedForDeletion(userId))) return { deletedRows: 0, status: "not_marked" }
    let deletedRows = 0
    for (;;) {
      const batch = await this.accounts.eraseNextBatch(userId, DELETE_BATCH)
      deletedRows += batch.deleted
      if (batch.done) break
    }
    await this.audit.record({ action: "account.deleted", actor: "system", target: userId, details: { rows: deletedRows } })
    return { deletedRows, status: "deleted" }
  }
}
