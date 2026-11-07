import { Hono } from "hono"

import type { Auth } from "../../../adapters/auth/auth"
import { requireSession } from "../middlewares/session"
import type { AppEnv } from "../types"

export function meRoutes(auth: Promise<Auth>) {
  return new Hono<AppEnv>().get("/me", requireSession(auth), (c) => c.json({ user: c.get("user") }))
}
