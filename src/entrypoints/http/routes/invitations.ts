import { Hono } from "hono"
import { setCookie } from "hono/cookie"
import { z } from "zod"

import type { InvitationStore } from "../../../core/ports/invitations"
import { hashInvitation, normalizeInvitation } from "../../../core/use-cases/admit-sign-in"
import { ApiError } from "../errors"
import { INVITATION_COOKIE } from "../middlewares/request-context"
import type { AppEnv } from "../types"

const ClaimBody = z.object({ code: z.string().min(1).max(64) })

/**
 * The web's first sign-in goes through Apple's redirect, which cannot carry a header, so the web
 * checks the code here first and the API keeps it in a short-lived cookie that the Apple callback
 * then brings along. The code is consumed only when the account is created. The iPhone skips this
 * and sends the code in `x-keepwell-invitation` with its ID token.
 */
export function invitationRoutes(deps: { invitations: InvitationStore; secure: boolean; cookieDomain?: string; now?: () => Date }) {
  return new Hono<AppEnv>().post("/invitations/claim", async (c) => {
    const body = ClaimBody.safeParse(await c.req.json().catch(() => undefined))
    if (!body.success || normalizeInvitation(body.data.code).length === 0) throw new ApiError(400, "invalid_request", "Send the invitation code.")
    const open = await deps.invitations.isOpen(hashInvitation(body.data.code), deps.now?.() ?? new Date())
    // One answer for unknown, used and expired: the response says nothing about which codes exist.
    if (!open) throw new ApiError(404, "invitation_not_found", "That invitation is not valid. It may have expired or been used.")
    setCookie(c, INVITATION_COOKIE, normalizeInvitation(body.data.code), {
      httpOnly: true,
      secure: deps.secure,
      // Apple comes back with a cross-site POST that redirects to a GET; a Lax cookie is dropped
      // along that chain. It carries only an invitation code, for 30 minutes, under /api/auth.
      sameSite: deps.secure ? "None" : "Lax",
      path: "/api/auth",
      maxAge: 30 * 60,
      ...(deps.cookieDomain ? { domain: deps.cookieDomain } : {}),
    })
    return c.body(null, 204)
  })
}
