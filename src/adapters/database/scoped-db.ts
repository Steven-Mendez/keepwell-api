import { and, eq, type SQL } from "drizzle-orm"
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core"

import type { Database } from "./client"
import type { Transaction } from "./with-transaction"

/** Any table that belongs to a user. */
export type UserTable = PgTable & { user_id: AnyPgColumn }

type Row = Record<string, unknown>

/**
 * The only way repositories reach user data (ADR 0004). Every read is filtered by the user, every
 * write is stamped with the user and limited to the user's rows, and `user_id` in caller data is
 * ignored. DSQL has no row-level security, so this is where isolation lives; tests/isolation tries
 * to break it. Repositories receive a ScopedDb, never the raw client (enforced by ESLint).
 */
export interface ScopedDb {
  readonly userId: string
  select<T extends UserTable>(table: T, where?: SQL): Promise<Row[]>
  insert<T extends UserTable>(table: T, rows: Row[]): Promise<void>
  update<T extends UserTable>(table: T, values: Row, where: SQL): Promise<number>
  delete<T extends UserTable>(table: T, where: SQL): Promise<number>
}

export function scopedDb(handle: Database | Transaction, userId: string): ScopedDb {
  if (!userId) throw new Error("scopedDb needs a user")
  const mine = (table: UserTable, where?: SQL) => (where ? and(eq(table.user_id, userId), where)! : eq(table.user_id, userId))
  const withoutUser = (row: Row) => {
    const { user_id: _ignored, ...rest } = row
    return rest
  }
  return {
    userId,
    async select(table, where) {
      return (await handle.select().from(table as PgTable).where(mine(table, where))) as Row[]
    },
    async insert(table, rows) {
      if (rows.length === 0) return
      await handle.insert(table).values(rows.map((row) => ({ ...withoutUser(row), user_id: userId })) as never)
    },
    async update(table, values, where) {
      const set = withoutUser(values)
      if (Object.keys(set).length === 0) return 0
      const result = await handle.update(table).set(set as never).where(mine(table, where))
      return result.rowCount ?? 0
    },
    async delete(table, where) {
      const result = await handle.delete(table).where(mine(table, where))
      return result.rowCount ?? 0
    },
  }
}
