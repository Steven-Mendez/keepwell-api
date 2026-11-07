import type { RecordSource, SyncEntity, SyncRow } from "../domain/schema"

// The conflict rules of ADR 0005, as one pure function so the server, the tests and the convergence
// simulation share them. Clients apply the same rules in `applyRemote` (web) and its iOS twin.

export type StoredRow = SyncRow & { source?: RecordSource }

export type Decision =
  | { result: "applied"; row: StoredRow; operation: "create" | "update" | "delete" }
  | { result: "stale"; why: "tombstone_is_final" | "older_than_stored" }

/** Entities whose rows record who created them. */
export const SOURCED_ENTITIES: ReadonlySet<SyncEntity> = new Set(["transaction", "recurringRule"])

/**
 * - `updated_at` from the future is capped at the server's clock, so a device whose clock runs
 *   ahead can't win every conflict.
 * - A tombstone is final: nothing revives a deleted row.
 * - A delete always applies over a live row.
 * - Otherwise the later `updated_at` wins, and on a tie the one that arrives later wins: the
 *   server's order is the only one every device agrees on. (Capping makes ties common: two quick
 *   edits from a device whose clock runs ahead both land on the server's "now".)
 * - `source` is the server's: `createdBy` when the row is created, kept as stored afterwards,
 *   whatever the client sends.
 */
export function decide(
  entity: SyncEntity,
  existing: StoredRow | undefined,
  incoming: SyncRow,
  serverNow: string,
  createdBy: RecordSource = "app"
): Decision {
  if (existing?.deleted_at) return { result: "stale", why: "tombstone_is_final" }
  const capped: SyncRow = incoming.updated_at > serverNow ? { ...incoming, updated_at: serverNow } : incoming
  const row: StoredRow = SOURCED_ENTITIES.has(entity) ? { ...capped, source: existing?.source ?? createdBy } : stripSource(capped)
  if (row.deleted_at !== null) return { result: "applied", row, operation: "delete" }
  if (!existing) return { result: "applied", row, operation: "create" }
  if (row.updated_at >= existing.updated_at) return { result: "applied", row, operation: "update" }
  return { result: "stale", why: "older_than_stored" }
}

function stripSource(row: SyncRow): StoredRow {
  const { source: _ignored, ...rest } = row as SyncRow & { source?: unknown }
  return rest as StoredRow
}
