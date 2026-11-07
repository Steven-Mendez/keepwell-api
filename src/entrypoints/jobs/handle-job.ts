import { z } from "zod"

import type { Logger } from "../../adapters/observability/logger"
import type { DeleteAccountData } from "../../core/use-cases/delete-account-data"

const JobMessage = z.discriminatedUnion("type", [z.object({ type: z.literal("delete-account"), userId: z.string().min(1) })])

/** Runs one queue message. Throws to have SQS redeliver it (and, after five tries, park it in the DLQ). */
export async function handleJob(body: string, deps: { deleteAccount: DeleteAccountData; log: Logger }) {
  const parsed = JobMessage.safeParse(JSON.parse(body))
  if (!parsed.success) {
    // A malformed message never becomes valid: log it and let it go rather than poison the queue.
    deps.log.error({ issues: parsed.error.issues.length }, "unknown job dropped")
    return
  }
  const job = parsed.data
  const result = await deps.deleteAccount.execute(job.userId)
  deps.log.info({ job: job.type, status: result.status, rows: result.deletedRows }, "job done")
}
