// Creates a single-use invitation and prints the code once; only its hash is stored.
// Usage: DB_HOST=... (or DATABASE_URL=...) pnpm invite [days=7] [note]
import { DrizzleAuditLog } from "../src/adapters/database/audit-log"
import { createDatabase } from "../src/adapters/database/client"
import { DrizzleInvitationStore } from "../src/adapters/database/invitation-store"
import { createLogger } from "../src/adapters/observability/logger"
import { createInvitation } from "../src/core/use-cases/admit-sign-in"

const [daysText = "7", ...noteWords] = process.argv.slice(2)
const days = Number(daysText)
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("Usage: pnpm invite [days 1–90] [note]")
const log = createLogger({ version: "script" })
const host = process.env.DB_HOST
const { db, close } = host
  ? createDatabase({ kind: "dsql", host, user: "admin", region: process.env.AWS_REGION, maxConnections: 1 }, log)
  : createDatabase({ kind: "postgres", url: process.env.DATABASE_URL!, maxConnections: 1 }, log)
try {
  const { code, expiresAt } = await createInvitation(new DrizzleInvitationStore(db), new DrizzleAuditLog(db), { days, note: noteWords.join(" ") || null })
  process.stdout.write(`${code}\nExpires ${expiresAt.toISOString()}. Shown once; give it to one person.\n`)
} finally {
  await close()
}
