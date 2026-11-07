// Replays change_log and compares it with the ledger tables. Exit code 1 on any discrepancy, so
// it can run as a scheduled check or by hand during an incident. Logs keys and column names only.
// Usage: DB_HOST=... (or DATABASE_URL=...) pnpm reconcile [userId...]
import { createDatabase } from "../src/adapters/database/client"
import { DrizzleReconciliationSource } from "../src/adapters/database/reconciliation-source"
import { createLogger } from "../src/adapters/observability/logger"
import { Reconcile } from "../src/core/use-cases/reconcile"

const log = createLogger({ version: process.env.APP_VERSION ?? "local" })
const host = process.env.DB_HOST
const { db, close } = host
  ? createDatabase({ kind: "dsql", host, user: "admin", region: process.env.AWS_REGION, maxConnections: 1 }, log)
  : createDatabase({ kind: "postgres", url: process.env.DATABASE_URL!, maxConnections: 1 }, log)
try {
  const users = process.argv.slice(2)
  const result = await new Reconcile(new DrizzleReconciliationSource(db)).execute(users.length ? users : undefined)
  log.info({ metric: "reconciliation", users: result.users, rows: result.rows, discrepancies: result.discrepancies.length }, "reconciliation finished")
  for (const d of result.discrepancies) log.error({ metric: "reconciliation_discrepancy", ...d }, "ledger differs from change_log")
  process.exitCode = result.discrepancies.length > 0 ? 1 : 0
} finally {
  await close()
}
