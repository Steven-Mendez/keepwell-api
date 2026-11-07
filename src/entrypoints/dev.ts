import { serve } from "@hono/node-server"

import { createLogger } from "../adapters/observability/logger"
import { createApp } from "./http/app"

const port = Number(process.env.PORT ?? 3001)
const logger = createLogger({ version: "dev", level: "debug" })
const app = createApp({ logger, version: "dev" })

serve({ fetch: app.fetch, port }, () => logger.info({ port }, "keepwell-api listening"))
