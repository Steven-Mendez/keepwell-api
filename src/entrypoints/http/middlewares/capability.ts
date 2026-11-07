import type { MiddlewareHandler } from "hono"

import type { Capability } from "../../../core/capabilities"
import type { ResolveCapabilities } from "../../../core/use-cases/resolve-capabilities"
import { ApiError } from "../errors"
import type { AppEnv } from "../types"

/**
 * After authentication, never before: 401 says "who are you", 403 `needs_plan` says "you can't, and
 * here is what you'd need". Apps stop retrying on `needs_plan` until GET /me changes.
 */
export function requireCapability(capabilities: Promise<ResolveCapabilities>, capability: Capability): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user")
    if (!(await (await capabilities).has(user.id, capability))) {
      throw new ApiError(403, "needs_plan", `This needs ${capability}.`, { capability })
    }
    await next()
  }
}
