import { describe, expect, it } from "vitest"

import v1 from "../../src/core/domain/fixtures/sync-v1.json"
import { validateSyncEvent } from "../../src/core/domain/schema"

// The frozen v1 rows keepwell-web and keepwell-ios run too. Phones and this server already hold rows
// like these, so the schema the server validates pushes with must still accept each one and keep
// every column: a renamed, removed or newly required column fails here.

/** Only the server writes these; the schema drops them on purpose. */
const SERVER_COLUMNS = new Set(["user_id", "server_seq", "applied_at"])

describe("sync format v1", () => {
  it("is version 1", () => {
    expect(v1.version).toBe(1)
  })

  it.each(v1.valid.map((c) => [c.name, c] as const))("still reads %s", (_, c) => {
    const result = validateSyncEvent(c.event)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.event).toMatchObject({ entity: c.event.entity, entity_id: c.event.entity_id, operation: c.event.operation })
    const row = result.row as Record<string, unknown>
    for (const [column, value] of Object.entries(c.event.payload)) {
      if (SERVER_COLUMNS.has(column)) continue
      expect(row, `${c.event.entity}.${column}`).toHaveProperty([column], value)
    }
  })
})
