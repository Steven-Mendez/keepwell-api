import { Hono } from "hono"

import type { Auth } from "../../../adapters/auth/auth"
import type { RequestAccountDeletion } from "../../../core/use-cases/request-account-deletion"
import { requireSession } from "../middlewares/session"
import type { AppEnv } from "../types"

/** How long AWS Backup keeps copies after a deletion; the apps show it before confirming. */
export const BACKUP_RETENTION_DAYS = 35

export function meRoutes(auth: Promise<Auth>, deps: { requestDeletion?: Promise<RequestAccountDeletion> } = {}) {
  const routes = new Hono<AppEnv>().get("/me", requireSession(auth), (c) => c.json({ user: c.get("user") }))
  if (deps.requestDeletion) {
    const requestDeletion = deps.requestDeletion
    routes.delete("/me", requireSession(auth), async (c) => {
      const { requestedAt } = await (await requestDeletion).execute(c.get("user").id)
      return c.json({ status: "deletion_requested", requested_at: requestedAt.toISOString(), backups_retained_days: BACKUP_RETENTION_DAYS }, 202)
    })
  }
  return routes
}
