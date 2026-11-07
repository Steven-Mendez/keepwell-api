import pg from "pg"

import { createDatabase } from "../../src/adapters/db/client"
import { runMigrations } from "../../src/adapters/db/migrate"
import { createLogger } from "../../src/adapters/observability/logger"
import { adminUrl, TEST_DATABASE } from "./env"

/**
 * Recreates the test database and migrates it once per run. Integration tests need the local
 * Postgres from docker-compose.yml (`pnpm db:up`); CI starts the same image as a service.
 */
export default async function setup() {
  const server = new pg.Client({ connectionString: adminUrl("postgres") })
  try {
    await server.connect()
  } catch (error) {
    throw new Error(`Integration tests need Postgres at ${adminUrl("postgres")}. Run \`pnpm db:up\`.`, { cause: error })
  }
  await server.query(`drop database if exists ${TEST_DATABASE} with (force)`)
  await server.query(`create database ${TEST_DATABASE}`)
  await server.end()

  const { db, close } = createDatabase({ kind: "postgres", url: adminUrl(TEST_DATABASE) })
  await runMigrations(db, "postgres", createLogger({ version: "test", level: "silent" }))
  await close()
}
