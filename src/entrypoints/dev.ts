import { serve } from "@hono/node-server"

import { APP_ROLE, createDatabase } from "../adapters/db/client"
import { pingDatabase } from "../adapters/db/health"
import { createLogger } from "../adapters/observability/logger"
import { createApp } from "./http/app"

// Local development against docker-compose's Postgres, connected as the app role like production.
const port = Number(process.env.PORT ?? 3001)
const logger = createLogger({ version: "dev", level: "debug" })
const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/keepwell"
const { db } = createDatabase({ kind: "postgres", url, role: APP_ROLE }, logger)
const app = createApp({ logger, version: "dev", healthChecks: [{ name: "db", run: () => pingDatabase(db) }] })

serve({ fetch: app.fetch, port }, () => logger.info({ port }, "keepwell-api listening"))
