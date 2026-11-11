import type { SyncEntity } from "../domain/schema"

/** One row an MCP delete took away or changed, as it was before (ADR 0011). */
export interface TrashedRow {
  entity: SyncEntity
  /** The wire row before the delete (audit columns included). */
  before: Record<string, unknown>
  /** `true`: the delete tombstoned it. `false`: the delete changed it (a movement moved to "Other"). */
  deleted: boolean
  /** For a changed row, the `updated_at` the delete wrote: restoring reverts it only if nothing changed it since. */
  afterUpdatedAt?: string
}

export interface TrashEntry {
  id: string
  clientId: string
  /** What was deleted, in the person's words: "Account BAC Ahorro", "Category Food". */
  label: string
  rows: TrashedRow[]
  createdAt: Date
  restoredAt: Date | null
}

/** What MCP deletes keep for a while so they can be undone: tombstones are final in sync (ADR 0005). */
export interface McpTrash {
  save(userId: string, entry: Omit<TrashEntry, "createdAt" | "restoredAt">, at: Date): Promise<void>
  /** Not restored, newest first, created after `since`. */
  list(userId: string, since: Date): Promise<TrashEntry[]>
  get(userId: string, id: string): Promise<TrashEntry | undefined>
  markRestored(userId: string, id: string, at: Date): Promise<void>
  /** Forgets entries created before `before` (they hold copies of finance data). */
  purge(userId: string, before: Date): Promise<void>
}
