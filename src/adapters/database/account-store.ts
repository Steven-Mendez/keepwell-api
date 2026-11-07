import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import type { AccountStore } from "../../core/ports/account-store"
import type { Logger } from "../observability/logger"
import type { Database } from "./client"
import { accounts, sessions, users } from "./schema"
import { withTransaction } from "./with-transaction"

/**
 * Every table that holds a user's rows, erased in this order by account deletion. A table that gets
 * a `user_id` column is added here in the same commit; tests/database/account-deletion.test.ts
 * fails when a table with `user_id` is missing from this list or from KEPT_AFTER_DELETION.
 */
export const USER_OWNED_TABLES: { name: string; table: PgTable; userIdColumn: string }[] = [
  { name: "sessions", table: sessions, userIdColumn: "user_id" },
  { name: "accounts", table: accounts, userIdColumn: "user_id" },
]

/**
 * Tables that keep rows of a deleted account on purpose: `audit_log` is insert-only for the app
 * role (security record, ADR 0004). Documented in the privacy policy.
 */
export const KEPT_AFTER_DELETION = ["audit_log", "users"]

export class DrizzleAccountStore implements AccountStore {
  constructor(
    private readonly db: Database,
    private readonly log: Logger
  ) {}

  async markForDeletion(userId: string, at: Date): Promise<Date | undefined> {
    return withTransaction(this.db, this.log, async (tx) => {
      const [user] = await tx.select({ requested: users.deletionRequestedAt }).from(users).where(eq(users.id, userId))
      if (!user) return undefined
      if (!user.requested) await tx.update(users).set({ deletionRequestedAt: at }).where(and(eq(users.id, userId), isNull(users.deletionRequestedAt)))
      await tx.delete(sessions).where(eq(sessions.userId, userId))
      return user.requested ?? at
    })
  }

  async isMarkedForDeletion(userId: string): Promise<boolean> {
    const rows = await this.db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNotNull(users.deletionRequestedAt)))
    if (rows.length > 0) return true
    // Already fully erased: the job finished before. Nothing left to do, which counts as marked.
    const any = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId))
    return any.length === 0
  }

  async eraseNextBatch(userId: string, batchSize: number) {
    for (const { name, table, userIdColumn } of USER_OWNED_TABLES) {
      const deleted = await withTransaction(this.db, this.log, async (tx) => {
        const ids = await tx.execute<{ id: string }>(
          sql`select id from ${table} where ${sql.identifier(userIdColumn)} = ${userId} limit ${batchSize}`
        )
        if (ids.rows.length === 0) return 0
        await tx.execute(sql`delete from ${table} where id in (${sql.join(ids.rows.map((r) => sql`${r.id}`), sql`, `)})`)
        return ids.rows.length
      })
      if (deleted > 0) return { table: name, deleted, done: false }
    }
    const removed = await withTransaction(this.db, this.log, async (tx) =>
      tx.delete(users).where(and(inArray(users.id, [userId]), isNotNull(users.deletionRequestedAt))).returning({ id: users.id })
    )
    return { table: "users", deleted: removed.length, done: true }
  }
}
