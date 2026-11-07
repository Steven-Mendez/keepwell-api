import { Hono } from "hono"

import type { Auth } from "../../../adapters/auth/auth"
import type { AppEnv } from "../types"

/** Better Auth answers everything under /api/auth with web-standard Request/Response. */
export function authRoutes(auth: Promise<Auth>) {
  return new Hono<AppEnv>().on(["GET", "POST"], "/api/auth/*", async (c) => (await auth).handler(c.req.raw))
}
