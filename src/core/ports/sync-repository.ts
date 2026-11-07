import type { SyncEntity, SyncOperation } from "../domain/schema"
import type { StoredRow } from "../sync/conflict"

export type EventResult = "applied" | "stale" | "rejected"

export interface StoredEventResult {
  result: EventResult
  reason: string | null
  serverSeq: number | null
}

export interface ChangeEntry {
  serverSeq: number
  entity: SyncEntity
  entityId: string
  operation: SyncOperation
  row: StoredRow
  clientId: string
  eventId: string
}

/** One user's writes inside one database transaction. Only SQL behind it (ADR 0003). */
export interface SyncUnitOfWork {
  /** Results already recorded for these events, by event id. */
  previousResults(eventIds: string[]): Promise<Map<string, StoredEventResult>>
  /** Bumps the user's sequence by `count` and returns the first new value. Serializes a user's writes. */
  reserveSequence(count: number): Promise<number>
  currentRow(entity: SyncEntity, id: string): Promise<StoredRow | undefined>
  writeRow(entity: SyncEntity, row: StoredRow, exists: boolean): Promise<void>
  appendChange(entry: ChangeEntry & { status: "applied" | "stale" }): Promise<void>
  recordResult(eventId: string, result: StoredEventResult): Promise<void>
  /** The server's clock, read inside the transaction. */
  now(): string
}

export interface PulledChange {
  serverSeq: number
  entity: SyncEntity
  entityId: string
  operation: SyncOperation
  row: StoredRow
}

export interface SyncRepository {
  /** Runs `work` in one transaction for the user, re-running it whole on a write conflict. */
  transaction<T>(userId: string, work: (unit: SyncUnitOfWork) => Promise<T>): Promise<T>
  touchClient(userId: string, clientId: string, platform: string): Promise<void>
  /**
   * Applied changes after `cursor`, oldest first, the caller's own included: a device that skipped
   * its own changes could apply an older change from another device over a newer one of its own
   * (found by tests/convergence). `nextCursor` covers stale entries too.
   */
  pull(userId: string, cursor: number, limit: number): Promise<{ changes: PulledChange[]; nextCursor: number }>
  /** Current rows of one entity after `after` (by id), and the sequence they reflect. */
  snapshot(userId: string, entity: SyncEntity, after: string, limit: number): Promise<{ rows: StoredRow[]; serverSeq: number }>
}
