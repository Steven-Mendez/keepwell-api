import type { MiddlewareHandler } from "hono"

import type { Auth } from "../../../adapters/auth/auth"
import { ApiError } from "../errors"
import type { AppEnv } from "../types"

/** Resolves the Better Auth session from the cookie; 401 without one. */
export function requireSession(auth: Promise<Auth>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await (await auth).api.getSession({ headers: c.req.raw.headers })
    if (!session) throw new ApiError(401, "unauthorized", "Sign in to continue")
    c.set("user", { id: session.user.id, name: session.user.name, email: session.user.email })
    c.set("sessionId", session.session.id)
    await next()
  }
}
