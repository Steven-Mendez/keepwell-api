import { and, desc, gt, isNull, lt, eq } from "drizzle-orm"

import type { McpTrash, TrashEntry } from "../../../core/ports/mcp-trash"
import type { ScopedDb } from "../scoped-db"
import { mcpTrash } from "../sync-tables"

type Stored = typeof mcpTrash.$inferSelect

function entry(row: Stored): TrashEntry {
  return {
    id: row.id,
    clientId: row.client_id,
    label: row.label,
    rows: JSON.parse(row.rows) as TrashEntry["rows"],
    createdAt: row.created_at,
    restoredAt: row.restored_at,
  }
}

/** The MCP trash over a user's ScopedDb (ADR 0011). */
export class ScopedMcpTrash implements McpTrash {
  constructor(private readonly scoped: (userId: string) => ScopedDb) {}

  async save(userId: string, value: Omit<TrashEntry, "createdAt" | "restoredAt">, at: Date) {
    await this.scoped(userId).insert(mcpTrash, [{ id: value.id, client_id: value.clientId, label: value.label, rows: JSON.stringify(value.rows), created_at: at }])
  }

  async list(userId: string, since: Date) {
    const rows = await this.scoped(userId).select(mcpTrash, and(gt(mcpTrash.created_at, since), isNull(mcpTrash.restored_at)), { orderBy: desc(mcpTrash.created_at), limit: 50 })
    return (rows as Stored[]).map(entry)
  }

  async get(userId: string, id: string) {
    const [row] = (await this.scoped(userId).select(mcpTrash, eq(mcpTrash.id, id), { limit: 1 })) as Stored[]
    return row ? entry(row) : undefined
  }

  async markRestored(userId: string, id: string, at: Date) {
    await this.scoped(userId).update(mcpTrash, { restored_at: at }, eq(mcpTrash.id, id))
  }

  async purge(userId: string, before: Date) {
    await this.scoped(userId).delete(mcpTrash, lt(mcpTrash.created_at, before))
  }
}
