import { getTableName, sql } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { LEDGER_TABLES } from "../../src/adapters/database/sync-tables"
import wire from "../../src/core/domain/fixtures/wire-columns.json"
import { SYNC_ENTITIES } from "../../src/core/domain/schema"
import { adminDatabase } from "../support/database"

type WireColumn = { type: "string" | "number" | "boolean" | "array" | "object"; nullable: boolean; optional: boolean }
const ENTITIES = wire.entities as Record<string, Record<string, WireColumn>>

/** How each wire type is stored (ADR 0004): arrays and objects as JSON text. */
const STORED_AS: Record<WireColumn["type"], string> = { string: "text", number: "integer", boolean: "boolean", array: "text", object: "text" }
/** Columns of ours beside the wire row: the owner, and who created it (ADR 0005). */
const SERVER_COLUMNS = new Set(["user_id", "source"])

// The migrated tables against the shared list of wire columns (fixtures/wire-columns.json), so a
// migration that forgets a column, or makes an optional one NOT NULL, fails here and not in a push.
describe("the migrated ledger tables match the wire columns", () => {
  const admin = adminDatabase()
  afterAll(() => admin.close())

  it("lists every sync entity", () => {
    expect(Object.keys(ENTITIES).sort()).toEqual([...SYNC_ENTITIES].sort())
  })

  for (const entity of SYNC_ENTITIES) {
    it(entity, async () => {
      const table = getTableName(LEDGER_TABLES[entity])
      const rows = (
        await admin.db.execute<{ column_name: string; data_type: string; is_nullable: string }>(
          sql`select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = ${table}`
        )
      ).rows
      const stored = new Map(rows.map((row) => [row.column_name, row]))
      for (const [name, column] of Object.entries(ENTITIES[entity]!)) {
        const found = stored.get(name)
        expect(found, `${table}.${name}`).toBeDefined()
        expect(found!.data_type, `${table}.${name} type`).toBe(STORED_AS[column.type])
        // `source` travels optional but is the server's, stored with a default.
        if (!SERVER_COLUMNS.has(name)) expect(found!.is_nullable, `${table}.${name} nullable`).toBe(column.nullable || column.optional ? "YES" : "NO")
      }
      const extra = rows.map((row) => row.column_name).filter((name) => !(name in ENTITIES[entity]!) && !SERVER_COLUMNS.has(name))
      expect(extra, `${table} columns not on the wire`).toEqual([])
    })
  }
})
