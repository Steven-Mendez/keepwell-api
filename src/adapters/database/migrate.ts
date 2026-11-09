import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { migrate as migrateDsql } from "@aws/aurora-dsql-drizzle"
import { sql } from "drizzle-orm"
import { readMigrationFiles } from "drizzle-orm/migrator"

import type { Logger } from "../observability/logger"
import type { Database } from "./client"

export const MIGRATIONS_FOLDER = new URL("../../../drizzle/migrations", import.meta.url).pathname

/**
 * Applies pending migrations one statement at a time.
 *
 * - DSQL: the official adapter's migrator, which runs each DDL in its own transaction, records each
 *   statement, and waits for asynchronous index jobs before recording them.
 *   Statements DSQL refuses but doesn't need are blanked in a temporary copy (`forDsql`): the
 *   files on disk never change, and a blank chunk is recorded without running.
 * - Local Postgres: the same files and the same statement-by-statement tracking, with `ASYNC`
 *   removed (Postgres has no asynchronous DDL), and an already existing role tolerated because
 *   roles outlive a dropped test database.
 */
export async function runMigrations(db: Database, target: "dsql" | "postgres", log: Logger, folder = MIGRATIONS_FOLDER) {
  if (target === "dsql") {
    const result = await migrateDsql(db, { migrationsFolder: forDsql(folder) })
    if (!result.success) throw new Error(`Migration ${result.error.migrationName}#${result.error.statementIndex} failed: ${result.error.message}`)
    log.info({ applied: result.appliedStatements }, "migrations applied")
    return result.appliedStatements
  }
  return migratePostgres(db, log, folder)
}

async function migratePostgres(db: Database, log: Logger, folder: string): Promise<number> {
  await db.execute(sql`create schema if not exists drizzle`)
  await db.execute(sql`
    create table if not exists drizzle.__local_migrations (
      migration_folder_millis bigint not null,
      statement_index integer not null,
      hash text not null,
      applied_at timestamptz not null default now(),
      primary key (migration_folder_millis, statement_index)
    )`)
  const applied = await db.execute<{ migration_folder_millis: string; statement_index: number }>(
    sql`select migration_folder_millis, statement_index from drizzle.__local_migrations`
  )
  const done = new Set(applied.rows.map((row) => `${row.migration_folder_millis}:${row.statement_index}`))
  let count = 0
  for (const migration of readMigrationFiles({ migrationsFolder: folder })) {
    for (const [index, raw] of migration.sql.entries()) {
      if (done.has(`${migration.folderMillis}:${index}`)) continue
      const statement = toPostgres(raw.trim())
      if (statement) {
        try {
          await db.execute(sql.raw(statement))
        } catch (error) {
          if (!(isDuplicateRole(error) && /^CREATE ROLE/i.test(withoutLeadingComments(statement)))) throw error
        }
      }
      const hash = createHash("sha256").update(raw).digest("hex")
      await db.execute(
        sql`insert into drizzle.__local_migrations (migration_folder_millis, statement_index, hash) values (${migration.folderMillis}, ${index}, ${hash})`
      )
      count++
    }
  }
  log.info({ applied: count }, "migrations applied")
  return count
}

function withoutLeadingComments(statement: string): string {
  return statement.replace(/^(\s*--[^\n]*\n)+/, "").trim()
}

/** `CREATE INDEX ASYNC` and `ALTER TABLE ASYNC` are DSQL syntax; locally they run synchronously. */
export function toPostgres(statement: string): string {
  return withoutLeadingComments(statement)
    .replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX)\s+ASYNC\b/i, "$1")
    .replace(/^(\s*ALTER\s+TABLE)\s+ASYNC\b/i, "$1")
}

function isDuplicateRole(error: unknown): boolean {
  let current: unknown = error
  while (current && typeof current === "object") {
    if ((current as { code?: unknown }).code === "42710") return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Maps the API's database role to the Lambda's IAM role, so `dsql:DbConnect` with that IAM role
 * logs in as `keepwell_app`. Idempotent: it checks the mapping table first. DSQL only.
 */
export async function grantIamRole(db: Database, iamRoleArn: string, log: Logger, pgRole = "keepwell_app") {
  const existing = await db.execute<{ arn: string }>(
    sql`select arn from sys.iam_pg_role_mappings where pg_role_name = ${pgRole} and arn = ${iamRoleArn}`
  )
  if (existing.rows.length > 0) return
  await db.execute(sql.raw(`AWS IAM GRANT ${pgRole} TO '${iamRoleArn.replace(/'/g, "''")}'`))
  log.info({ pg_role: pgRole }, "iam role mapped")
}

/**
 * `GRANT USAGE ON SCHEMA public` is refused by DSQL ("feature not supported on system entity"):
 * there every role already uses `public`. Postgres needs it on older versions, so the migrations
 * keep it and DSQL gets a copy with that statement blank, at the same index.
 */
const DSQL_SKIPPED = /^\s*GRANT\s+USAGE\s+ON\s+SCHEMA\s+public\s+TO\s+\w+\s*;?\s*$/i

export function forDsql(folder: string): string {
  const copy = mkdtempSync(join(tmpdir(), "keepwell-migrations-"))
  cpSync(folder, copy, { recursive: true })
  for (const file of readdirSync(copy).filter((name) => name.endsWith(".sql"))) {
    const path = join(copy, file)
    const chunks = readFileSync(path, "utf8").split("--> statement-breakpoint")
    const kept = chunks.map((chunk) => (DSQL_SKIPPED.test(withoutLeadingComments(chunk.trim())) ? "\n" : chunk))
    writeFileSync(path, kept.join("--> statement-breakpoint"))
  }
  return copy
}
