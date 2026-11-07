import { serve } from "@hono/node-server"

import { APP_ROLE } from "../adapters/database/client"
import { createLogger } from "../adapters/observability/logger"
import { bootstrap } from "./bootstrap"

// Local development against docker-compose's Postgres, connected as the app role like production,
// with configuration from config.local.json (copy config.local.example.json).
const port = Number(process.env.PORT ?? 3001)
const logger = createLogger({ version: "dev", level: "debug" })
const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/keepwell"
const app = bootstrap({ logger, version: "dev", database: { kind: "postgres", url, role: APP_ROLE } })

serve({ fetch: app.fetch, port }, () => logger.info({ port }, "keepwell-api listening"))
