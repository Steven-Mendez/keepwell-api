import type { AccountStore } from "../ports/account-store"
import type { AuditLog } from "../ports/audit-log"
import type { JobQueue } from "../ports/job-queue"

/**
 * App Store guideline 5.1.1: an account can be deleted from inside the app. The request marks it
 * and ends every session in one transaction, so access stops at once, and only then queues the
 * erasure, which is too large for one DSQL transaction. If queueing fails the person retries: the
 * mark is idempotent and the job is safe to run twice.
 */
export class RequestAccountDeletion {
  constructor(
    private readonly accounts: AccountStore,
    private readonly queue: JobQueue,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(userId: string): Promise<{ requestedAt: Date }> {
    const requestedAt = await this.accounts.markForDeletion(userId, this.now())
    if (!requestedAt) throw new Error("No such user")
    await this.audit.record({ action: "account.deletion_requested", userId })
    await this.queue.enqueue({ type: "delete-account", userId })
    return { requestedAt }
  }
}
