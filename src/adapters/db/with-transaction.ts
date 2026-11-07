import type { AwsDsqlTransaction } from "@aws/aurora-dsql-drizzle"
import type { ExtractTablesWithRelations } from "drizzle-orm"

import type { Logger } from "../observability/logger"
import type { Database, Schema } from "./client"

export type Transaction = AwsDsqlTransaction<Schema, ExtractTablesWithRelations<Schema>>

/**
 * Every write goes through here. DSQL (and local Postgres at repeatable read) resolve concurrent
 * writes optimistically: the loser fails at commit with OC000/OC001 or 40001, and the whole closure
 * runs again. So the closure must contain **only SQL**: no HTTP calls, no queue messages, no
 * clocks read outside it that must stay fixed. Each retry is logged.
 */
export function withTransaction<T>(
  db: Database,
  log: Logger,
  work: (tx: Transaction) => Promise<T>,
  options: { maxRetries?: number } = {}
): Promise<T> {
  return db.transactionWithRetry(work, undefined, {
    maxRetries: options.maxRetries ?? 5,
    baseDelayMs: 20,
    maxDelayMs: 1_000,
    onRetry: (error, attempt, maxAttempts) =>
      log.warn({ attempt, max_attempts: maxAttempts, code: sqlState(error) }, "transaction conflict, retrying"),
  })
}

function sqlState(error: unknown): string | undefined {
  let current: unknown = error
  while (current && typeof current === "object") {
    const code = (current as { code?: unknown }).code
    if (typeof code === "string") return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}
