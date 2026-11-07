import type { MiddlewareHandler } from "hono"

import type { SwitchesSource } from "../../../core/switches"
import { ApiError } from "../errors"
import type { AppEnv } from "../types"

/** `read_only`: refuse the request with 503 while an incident is investigated. */
export function refuseWhenReadOnly(switches: SwitchesSource): MiddlewareHandler<AppEnv> {
  return async (_c, next) => {
    if ((await switches.current()).read_only) {
      throw new ApiError(503, "read_only", "Keepwell is read-only for a moment. Your changes stay on this device and sync later.", undefined, { "Retry-After": "300" })
    }
    await next()
  }
}

/** `mcp_enabled: false`: every MCP request is refused, whatever the token. */
export function refuseWhenMcpDisabled(switches: SwitchesSource): MiddlewareHandler<AppEnv> {
  return async (_c, next) => {
    if (!(await switches.current()).mcp_enabled) {
      throw new ApiError(503, "mcp_disabled", "The Keepwell connector is turned off for now.", undefined, { "Retry-After": "600" })
    }
    await next()
  }
}
