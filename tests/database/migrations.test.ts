import { sql } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { runMigrations, toPostgres } from "../../src/adapters/database/migrate"
import { adminDatabase } from "../support/database"
import { captureLogger } from "../support/logger"

describe("migrations", () => {
  const admin = adminDatabase()
  afterAll(() => admin.close())

  it("are already applied by the global setup, so a second run applies nothing", async () => {
    const { logger } = captureLogger()
    expect(await runMigrations(admin.db, "postgres", logger)).toBe(0)
  })

  it("create the app role the API connects as", async () => {
    const roles = await admin.db.execute<{ rolname: string }>(sql`select rolname from pg_roles where rolname = 'keepwell_app'`)
    expect(roles.rows).toHaveLength(1)
  })

  it("leave no foreign keys in the schema (ADR 0003)", async () => {
    const fks = await admin.db.execute(
      sql`select conname from pg_constraint c join pg_namespace n on n.oid = c.connamespace where c.contype = 'f' and n.nspname = 'public'`
    )
    expect(fks.rows).toEqual([])
  })

  it("run DSQL's asynchronous DDL synchronously on Postgres", () => {
    expect(toPostgres('CREATE INDEX ASYNC "ix" ON "t" ("a")')).toBe('CREATE INDEX "ix" ON "t" ("a")')
    expect(toPostgres('CREATE UNIQUE INDEX ASYNC "ix" ON "t" ("a")')).toBe('CREATE UNIQUE INDEX "ix" ON "t" ("a")')
    expect(toPostgres("ALTER TABLE ASYNC t VALIDATE CONSTRAINT c")).toBe("ALTER TABLE t VALIDATE CONSTRAINT c")
    expect(toPostgres("CREATE TABLE t (a text)")).toBe("CREATE TABLE t (a text)")
  })
})

describe("the app connection", () => {
  it("runs as keepwell_app, not as the superuser", async () => {
    const { appDatabase } = await import("../support/database")
    const app = appDatabase()
    const [row] = (await app.db.execute<{ current_user: string }>(sql`select current_user`)).rows
    await app.close()
    expect(row!.current_user).toBe("keepwell_app")
  })
})
