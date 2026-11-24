import { and, eq, isNull } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"

import type { SharedSplitIndex } from "../../core/ports/shared-splits"
import type { Database } from "./client"
import { transactions } from "./sync-tables"

// Wire columns are built from the zod schema, so their names aren't known to the table's type.
const shareToken = (transactions as unknown as Record<string, AnyPgColumn>).share_token!

/**
 * The one ledger read outside `ScopedDb`: a public link names no user, so its movement is found by
 * the token across users. It returns only the owner; everything shown is then read scoped to them.
 */
export class DrizzleSharedSplitIndex implements SharedSplitIndex {
  constructor(private readonly db: Database) {}

  async ownerOf(token: string) {
    const [row] = await this.db
      .select({ userId: transactions.user_id })
      .from(transactions)
      .where(and(eq(shareToken, token), isNull(transactions.deleted_at)))
      .limit(1)
    return row?.userId
  }
}
