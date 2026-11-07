import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"

import type { SyncEntity, SyncOperation } from "../../../core/domain/schema"
import type { StoredEventResult, SyncRepository, SyncUnitOfWork } from "../../../core/ports/sync-repository"
import type { StoredRow } from "../../../core/sync/conflict"
import { fromStored, toStored } from "../ledger-rows"
import type { ScopedDb } from "../scoped-db"
import { appliedEvents, changeLog, clients, LEDGER_TABLES, syncState } from "../sync-tables"

/**
 * Sync storage over a ScopedDb. `inTransaction` is provided by the caller (adapters/database/
 * sync-store.ts), which owns the raw client and the retrying transaction; this file only ever sees
 * one user's data.
 */
export class ScopedSyncRepository implements SyncRepository {
  constructor(
    private readonly scoped: (userId: string) => ScopedDb,
    private readonly inTransaction: <T>(userId: string, work: (scoped: ScopedDb, raw: { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>) => Promise<T>
  ) {}

  transaction<T>(userId: string, work: (unit: SyncUnitOfWork) => Promise<T>): Promise<T> {
    return this.inTransaction(userId, (scoped, raw) => work(unitOfWork(scoped, raw)))
  }

  async touchClient(userId: string, clientId: string, platform: string): Promise<void> {
    await this.inTransaction(userId, async (scoped) => {
      const seen = await scoped.update(clients, { last_seen_at: new Date(), platform }, eq(clients.client_id, clientId))
      if (seen === 0) await scoped.insert(clients, [{ client_id: clientId, platform }])
    })
  }

  async pull(userId: string, cursor: number, limit: number) {
    const scanned = await this.scoped(userId).select(changeLog, gt(changeLog.server_seq, cursor), { orderBy: asc(changeLog.server_seq), limit })
    const changes = scanned
      .filter((entry) => entry.status === "applied")
      .map((entry) => ({
        serverSeq: Number(entry.server_seq),
        entity: entry.entity as SyncEntity,
        entityId: entry.entity_id as string,
        operation: entry.operation as SyncOperation,
        row: JSON.parse(entry.payload as string) as StoredRow,
      }))
    const nextCursor = scanned.length > 0 ? Number(scanned[scanned.length - 1]!.server_seq) : cursor
    return { changes, nextCursor }
  }

  async snapshot(userId: string, entity: SyncEntity, after: string, limit: number) {
    // One transaction, so the rows and the sequence they reflect are the same snapshot.
    return this.inTransaction(userId, async (scoped) => {
      const table = LEDGER_TABLES[entity]
      const rows = await scoped.select(table, gt(table.id, after), { orderBy: asc(table.id), limit })
      const [state] = await scoped.select(syncState)
      return { rows: rows.map((row) => fromStored(entity, row) as StoredRow), serverSeq: Number(state?.last_seq ?? 0) }
    })
  }
}

function unitOfWork(scoped: ScopedDb, raw: { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }> }): SyncUnitOfWork {
  return {
    async previousResults(eventIds) {
      const results = new Map<string, StoredEventResult>()
      if (eventIds.length === 0) return results
      for (const row of await scoped.select(appliedEvents, inArray(appliedEvents.event_id, eventIds))) {
        results.set(row.event_id as string, {
          result: row.result as StoredEventResult["result"],
          reason: (row.reason as string | null) ?? null,
          serverSeq: row.server_seq === null ? null : Number(row.server_seq),
        })
      }
      return results
    },
    async reserveSequence(count) {
      // The write that serializes a user's transactions: two pushes conflict here, one retries.
      const result = await raw.execute(sql`
        insert into sync_state (user_id, last_seq, updated_at) values (${scoped.userId}, ${count}, now())
        on conflict (user_id) do update set last_seq = sync_state.last_seq + ${count}, updated_at = now()
        returning last_seq`)
      return Number(result.rows[0]!.last_seq) - count + 1
    },
    async currentRow(entity, id) {
      const table = LEDGER_TABLES[entity]
      const [row] = await scoped.select(table, eq(table.id, id))
      return row ? (fromStored(entity, row) as StoredRow) : undefined
    },
    async writeRow(entity, row, exists) {
      const table = LEDGER_TABLES[entity]
      const stored = toStored(entity, row as Record<string, unknown>)
      if (exists) await scoped.update(table, stored, and(eq(table.id, row.id))!)
      else await scoped.insert(table, [stored])
    },
    async appendChange(entry) {
      await scoped.insert(changeLog, [
        {
          server_seq: entry.serverSeq,
          entity: entry.entity,
          entity_id: entry.entityId,
          operation: entry.operation,
          payload: JSON.stringify(entry.row),
          status: entry.status,
          client_id: entry.clientId,
          event_id: entry.eventId,
        },
      ])
    },
    async recordResult(eventId, result) {
      await scoped.insert(appliedEvents, [{ event_id: eventId, result: result.result, reason: result.reason, server_seq: result.serverSeq }])
    },
    now: () => new Date().toISOString(),
  }
}
