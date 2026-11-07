import { SYNC_WIRE, type SyncEntity } from "../../core/domain/schema"
import { jsonColumns } from "./sync-tables"

// Wire row ⇄ stored row. The only difference is JSON text for array columns (opening balances,
// tags); everything else is stored exactly as it travels.

const JSON_COLUMNS = Object.fromEntries(
  Object.entries(SYNC_WIRE).map(([entity, wire]) => [entity, jsonColumns(wire)])
) as Record<SyncEntity, string[]>

export function toStored(entity: SyncEntity, row: Record<string, unknown>): Record<string, unknown> {
  const stored = { ...row }
  for (const column of JSON_COLUMNS[entity]) if (column in stored) stored[column] = JSON.stringify(stored[column])
  return stored
}

export function fromStored(entity: SyncEntity, stored: Record<string, unknown>): Record<string, unknown> {
  const { user_id: _user, ...row } = stored
  for (const column of JSON_COLUMNS[entity]) if (typeof row[column] === "string") row[column] = JSON.parse(row[column] as string)
  return row
}
