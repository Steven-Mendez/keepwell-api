import type { RecordSource, SyncEntity, SyncRow } from "../domain/schema"

// The conflict rules of ADR 0005, as one pure function so the server, the tests and the convergence
// simulation share them. Clients apply the same rules in `applyRemote` (web) and its iOS twin.

export type StoredRow = SyncRow & { source?: RecordSource }

export type Decision =
  | { result: "applied"; row: StoredRow; operation: "create" | "update" | "delete" }
  | { result: "stale"; why: "tombstone_is_final" | "older_than_stored" }

/** Columns nobody edits: once set, the stored value is kept, as `source` is. */
export const KEPT_ONCE_SET: Partial<Record<SyncEntity, readonly string[]>> = { transaction: ["imported_id"] }

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
 * - A column the incoming row lacks keeps its stored value. Only optional wire columns can be
 *   absent, and only from an app older than the column (settings `time_zone`, an account's
 *   `closed_at`, the merchant links of movements and rules, a debt repayment's `transaction_id`):
 *   replacing the row whole would clear it here and, through the change log, on every other
 *   device. Sending `null` still clears it.
 * - A column in `KEPT_ONCE_SET` is the server's once it isn't null (a movement's `imported_id`):
 *   whatever the client sends, absent, `null` or another value, the stored one stays, in the table
 *   and in the change log. Apps that don't know it (iOS before the field) can then edit the row.
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
  const sourced: StoredRow = SOURCED_ENTITIES.has(entity) ? { ...capped, source: existing?.source ?? createdBy } : stripSource(capped)
  const row = existing ? keepSetColumns(entity, sourced, existing) : sourced
  if (row.deleted_at !== null) return { result: "applied", row, operation: "delete" }
  if (!existing) return { result: "applied", row, operation: "create" }
  if (row.updated_at >= existing.updated_at) return { result: "applied", row: keepAbsentColumns(row, existing), operation: "update" }
  return { result: "stale", why: "older_than_stored" }
}

function keepAbsentColumns(row: StoredRow, existing: StoredRow): StoredRow {
  const kept: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(existing)) if (!(column in row) && column !== "source") kept[column] = value
  return Object.keys(kept).length === 0 ? row : ({ ...kept, ...row } as StoredRow)
}

function keepSetColumns(entity: SyncEntity, row: StoredRow, existing: StoredRow): StoredRow {
  const kept: Record<string, unknown> = {}
  for (const column of KEPT_ONCE_SET[entity] ?? []) {
    const stored = (existing as Record<string, unknown>)[column]
    if (stored !== null && stored !== undefined) kept[column] = stored
  }
  return Object.keys(kept).length === 0 ? row : ({ ...row, ...kept } as StoredRow)
}

function stripSource(row: SyncRow): StoredRow {
  const { source: _ignored, ...rest } = row as SyncRow & { source?: unknown }
  return rest as StoredRow
}
