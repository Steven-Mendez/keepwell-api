import { and, eq, gt } from "drizzle-orm"

import type { McpWriteCounter } from "../../../core/ports/mcp-writes"
import type { ScopedDb } from "../scoped-db"
import { changeLog } from "../sync-tables"

/** Counts the client's rows in change_log: the log already says who wrote what and when. */
export class ChangeLogWriteCounter implements McpWriteCounter {
  constructor(private readonly scoped: (userId: string) => ScopedDb) {}

  async countSince(userId: string, clientId: string, since: Date): Promise<number> {
    return (await this.scoped(userId).select(changeLog, and(eq(changeLog.client_id, clientId), gt(changeLog.applied_at, since)))).length
  }
}
