import { Hono } from "hono"

import type { ViewSharedSplit } from "../../../core/use-cases/view-shared-split"
import { ApiError } from "../errors"
import type { AppEnv } from "../types"

/**
 * A split expense's public page, without a session: the link's token is the only key. One answer for
 * a malformed, unknown or revoked link, so the response says nothing about which tokens exist.
 */
export function sharedRoutes(deps: { view: ViewSharedSplit }) {
  return new Hono<AppEnv>().get("/shared/:token", async (c) => {
    const view = await deps.view.execute(c.req.param("token"))
    if (!view) throw new ApiError(404, "shared_split_not_found", "This link is no longer available.")
    return c.json(view)
  })
}
