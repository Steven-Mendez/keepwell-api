// Runs migrations against one environment. In the pipeline: DB_HOST=<cluster endpoint> with the
// deploy role's credentials (connects as `admin`), and APP_IAM_ROLE_ARN to map keepwell_app.
// Locally: DATABASE_URL=postgres://... (see docker-compose.yml).
import { createDatabase } from "../src/adapters/database/client"
import { grantIamRole, runMigrations } from "../src/adapters/database/migrate"
import { createLogger } from "../src/adapters/observability/logger"

const log = createLogger({ version: process.env.APP_VERSION ?? "local" })
const host = process.env.DB_HOST
const url = process.env.DATABASE_URL
if (!host && !url) throw new Error("Set DB_HOST (DSQL) or DATABASE_URL (Postgres)")

// One connection: statements run one at a time and the tracking table is never raced.
const { db, close } = host
  ? createDatabase({ kind: "dsql", host, user: "admin", region: process.env.AWS_REGION, maxConnections: 1 }, log)
  : createDatabase({ kind: "postgres", url: url!, maxConnections: 1 }, log)

try {
  await runMigrations(db, host ? "dsql" : "postgres", log)
  // Each Lambda logs in as its own database role.
  if (host && process.env.APP_IAM_ROLE_ARN) await grantIamRole(db, process.env.APP_IAM_ROLE_ARN, log, "keepwell_app")
  if (host && process.env.JOBS_IAM_ROLE_ARN) await grantIamRole(db, process.env.JOBS_IAM_ROLE_ARN, log, "keepwell_jobs")
} finally {
  await close()
}
