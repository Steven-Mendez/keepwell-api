import { eq, sql } from "drizzle-orm"

import { SYNC_ENTITIES, type SyncEntity } from "../../core/domain/schema"
import type { LedgerSnapshot, ReconciliationSource } from "../../core/ports/reconciliation"
import type { Database } from "./client"
import { fromStored } from "./ledger-rows"
import { scopedDb } from "./scoped-db"
import { changeLog, LEDGER_TABLES } from "./sync-tables"

export class DrizzleReconciliationSource implements ReconciliationSource {
  constructor(private readonly db: Database) {}

  async users(): Promise<string[]> {
    const rows = await this.db.execute<{ user_id: string }>(sql`select distinct user_id from change_log`)
    return rows.rows.map((row) => row.user_id)
  }

  async replayHistory(userId: string): Promise<LedgerSnapshot> {
    const snapshot: LedgerSnapshot = new Map()
    const scoped = scopedDb(this.db, userId)
    const entries = (await scoped.select(changeLog, eq(changeLog.status, "applied"))).sort(
      (a, b) => Number(a.server_seq) - Number(b.server_seq)
    )
    for (const entry of entries) snapshot.set(`${entry.entity}:${entry.entity_id}`, JSON.parse(entry.payload as string))
    return snapshot
  }

  async projection(userId: string): Promise<LedgerSnapshot> {
    const snapshot: LedgerSnapshot = new Map()
    const scoped = scopedDb(this.db, userId)
    for (const entity of SYNC_ENTITIES as readonly SyncEntity[]) {
      for (const stored of await scoped.select(LEDGER_TABLES[entity])) {
        snapshot.set(`${entity}:${stored.id}`, fromStored(entity, stored))
      }
    }
    return snapshot
  }
}
