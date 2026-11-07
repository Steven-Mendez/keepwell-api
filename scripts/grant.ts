// Grants a plan by hand, for the first users and for support. Writes the entitlement and an audit
// entry. Usage: DB_HOST=... (or DATABASE_URL=...) pnpm grant <user-id> <plan> [days]
import { createDatabase } from "../src/adapters/database/client"
import { DrizzleAuditLog } from "../src/adapters/database/audit-log"
import { DrizzleEntitlementRepository } from "../src/adapters/database/entitlements"
import { createLogger } from "../src/adapters/observability/logger"
import { PlanName } from "../src/core/capabilities"

const [userId, planText, days] = process.argv.slice(2)
const plan = PlanName.parse(planText)
if (!userId) throw new Error("Usage: pnpm grant <user-id> <plan> [days]")
const log = createLogger({ version: "script" })
const host = process.env.DB_HOST
const { db, close } = host
  ? createDatabase({ kind: "dsql", host, user: "admin", region: process.env.AWS_REGION, maxConnections: 1 }, log)
  : createDatabase({ kind: "postgres", url: process.env.DATABASE_URL!, maxConnections: 1 }, log)
try {
  const expiresAt = days ? new Date(Date.now() + Number(days) * 86_400_000) : null
  const id = await new DrizzleEntitlementRepository(db).grant(userId, { plan, source: "manual", expiresAt })
  await new DrizzleAuditLog(db).record({ action: "entitlement.granted", actor: "system", userId, target: id, details: { plan, source: "manual", days: days ?? null } })
  log.info({ entitlement: id, plan }, "granted")
} finally {
  await close()
}
