import { readMigrationFiles } from "drizzle-orm/migrator"
import { describe, expect, it } from "vitest"

import { forDsql, MIGRATIONS_FOLDER } from "../../src/adapters/database/migrate"

describe("migrations for DSQL", () => {
  it("blank only the schema grants DSQL refuses, keeping every statement at its index", () => {
    const original = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER })
    const dsql = readMigrationFiles({ migrationsFolder: forDsql(MIGRATIONS_FOLDER) })
    expect(dsql.map((m) => [m.folderMillis, m.sql.length])).toEqual(original.map((m) => [m.folderMillis, m.sql.length]))
    const changed = original.flatMap((m, i) => m.sql.flatMap((statement, j) => (statement === dsql[i]!.sql[j] ? [] : [statement.trim()])))
    expect(changed.length).toBe(2)
    for (const statement of changed) expect(statement).toMatch(/GRANT USAGE ON SCHEMA public TO keepwell_(app|jobs);$/)
  })
})
