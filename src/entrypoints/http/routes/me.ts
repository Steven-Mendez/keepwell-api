import { Hono } from "hono"

import type { Auth } from "../../../adapters/auth/auth"
import type { RequestAccountDeletion } from "../../../core/use-cases/request-account-deletion"
import type { ResolveCapabilities } from "../../../core/use-cases/resolve-capabilities"
import { requireSession } from "../middlewares/session"
import type { AppEnv } from "../types"

/** How long AWS Backup keeps copies after a deletion; the apps show it before confirming. */
export const BACKUP_RETENTION_DAYS = 35

export function meRoutes(
  auth: Promise<Auth>,
  deps: { requestDeletion?: Promise<RequestAccountDeletion>; capabilities?: Promise<ResolveCapabilities> } = {}
) {
  /** Who is signed in, their plan and what it allows. Apps cache it for five minutes. */
  const routes = new Hono<AppEnv>().get("/me", requireSession(auth), async (c) => {
    const user = c.get("user")
    if (!deps.capabilities) return c.json({ user })
    const resolved = await (await deps.capabilities).execute(user.id)
    c.header("Cache-Control", "private, max-age=300")
    return c.json({ user, plan: resolved.plan, capabilities: resolved.capabilities, early_access: resolved.earlyAccess })
  })
  if (deps.requestDeletion) {
    const requestDeletion = deps.requestDeletion
    routes.delete("/me", requireSession(auth), async (c) => {
      const { requestedAt } = await (await requestDeletion).execute(c.get("user").id)
      return c.json({ status: "deletion_requested", requested_at: requestedAt.toISOString(), backups_retained_days: BACKUP_RETENTION_DAYS }, 202)
    })
  }
  return routes
}
