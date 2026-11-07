import { AuroraDSQLPool } from "@aws/aurora-dsql-node-postgres-connector"
import { drizzle, type AwsDsqlDatabase } from "@aws/aurora-dsql-drizzle"
import pg from "pg"

import type { Logger } from "../observability/logger"
import * as schema from "./schema"

export type Schema = typeof schema
export type Database = AwsDsqlDatabase<Schema>

/** The role the API connects as; it has no UPDATE or DELETE on the log tables. */
export const APP_ROLE = "keepwell_app"

export type DatabaseConfig =
  | { kind: "dsql"; host: string; user: string; region?: string }
  /** Local Postgres. `role` switches the session to the app role so permissions match DSQL. */
  | { kind: "postgres"; url: string; role?: string }

/** Reads the connection from the environment: DSQL under Lambda, a URL in development and tests. */
export function databaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConfig | undefined {
  if (env.DB_HOST) return { kind: "dsql", host: env.DB_HOST, user: env.DB_USER ?? APP_ROLE, region: env.AWS_REGION }
  if (env.DATABASE_URL) return { kind: "postgres", url: env.DATABASE_URL, role: env.DATABASE_ROLE }
  return undefined
}

/**
 * One small pool per Lambda instance. DSQL authenticates every new connection with a fresh IAM
 * token (the connector signs it), and closes connections after 60 minutes; recycling them at 55
 * means a warm instance reconnects on its own schedule instead of failing a request.
 */
export function createDatabase(config: DatabaseConfig, logger?: Logger): { db: Database; close: () => Promise<void> } {
  const pool =
    config.kind === "dsql"
      ? new AuroraDSQLPool({
          host: config.host,
          user: config.user,
          region: config.region,
          database: "postgres",
          max: 2,
          idleTimeoutMillis: 5 * 60_000,
          maxLifetimeSeconds: 55 * 60,
          connectionTimeoutMillis: 5_000,
        })
      : new pg.Pool({
          connectionString: config.url,
          max: 10,
          maxLifetimeSeconds: 55 * 60,
          // A startup parameter, so the role is in place before the first query on every connection.
          ...(config.role ? { options: `-c role=${config.role}` } : {}),
        })
  // An idle connection that DSQL closes emits here; the pool drops it and the next query reconnects.
  pool.on("error", (error) => logger?.warn({ err: error }, "idle database connection closed"))

  const db = drizzle({ client: pool, schema }) as Database
  return { db, close: () => pool.end() }
}
