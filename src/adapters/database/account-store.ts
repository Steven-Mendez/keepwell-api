import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"

import type { AccountStore } from "../../core/ports/account-store"
import type { Logger } from "../observability/logger"
import type { Database } from "./client"
import { sessions, users } from "./schema"
import { withTransaction } from "./with-transaction"

/**
 * Every table that holds a user's rows, erased in this order by the deletion job, with the column
 * that tells its rows apart within a user. A table that gets a `user_id` column is added here in the
 * same commit; tests/auth/account-deletion.test.ts fails when one is missing.
 */
export const USER_OWNED_TABLES: { name: string; key: string }[] = [
  { name: "sessions", key: "id" },
  { name: "oauth_access_tokens", key: "id" },
  { name: "oauth_refresh_tokens", key: "id" },
  { name: "oauth_consents", key: "id" },
  { name: "oauth_clients", key: "id" },
  { name: "accounts", key: "id" },
  { name: "transactions", key: "id" },
  { name: "recurring_rules", key: "id" },
  { name: "loan_payments", key: "id" },
  { name: "loans", key: "id" },
  { name: "personal_debt_repayments", key: "id" },
  { name: "personal_debts", key: "id" },
  { name: "savings_goals", key: "id" },
  { name: "categorization_rules", key: "id" },
  { name: "cards", key: "id" },
  { name: "ledger_accounts", key: "id" },
  { name: "categories", key: "id" },
  { name: "settings", key: "id" },
  { name: "change_log", key: "server_seq" },
  { name: "applied_events", key: "event_id" },
  { name: "clients", key: "client_id" },
  { name: "idempotency_keys", key: "key" },
  { name: "sync_state", key: "user_id" },
]

/**
 * Tables that keep something of a deleted account on purpose: `audit_log` is insert-only (security
 * record, ADR 0004) and `entitlements` keeps the App Store reference without `user_id` for the
 * accounting period. Documented in the privacy policy.
 */
export const KEPT_AFTER_DELETION = ["audit_log", "users", "entitlements"]

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
    for (const { name, key } of USER_OWNED_TABLES) {
      const table = sql.identifier(name)
      const column = sql.identifier(key)
      const deleted = await withTransaction(this.db, this.log, async (tx) => {
        const keys = await tx.execute<{ key: string }>(sql`select ${column}::text as key from ${table} where user_id = ${userId} limit ${batchSize}`)
        if (keys.rows.length === 0) return 0
        await tx.execute(
          sql`delete from ${table} where user_id = ${userId} and ${column}::text in (${sql.join(keys.rows.map((r) => sql`${r.key}`), sql`, `)})`
        )
        return keys.rows.length
      })
      if (deleted > 0) return { table: name, deleted, done: false }
    }
    // Plan grants keep their App Store reference for the accounting period, without the person.
    await withTransaction(this.db, this.log, (tx) => tx.execute(sql`update entitlements set user_id = null where user_id = ${userId}`))
    const removed = await withTransaction(this.db, this.log, async (tx) =>
      tx.delete(users).where(and(inArray(users.id, [userId]), isNotNull(users.deletionRequestedAt))).returning({ id: users.id })
    )
    return { table: "users", deleted: removed.length, done: true }
  }

}
