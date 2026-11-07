import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import type { AppEnv } from "./types"

/** The one error shape clients see: a stable code, a human message and the request id. Never a stack or SQL. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
  request_id: string
}

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>
  ) {
    super(message)
  }
}

export function errorBody(c: Context<AppEnv>, code: string, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) }, request_id: c.get("requestId") }
}

export function onError(error: Error, c: Context<AppEnv>) {
  if (error instanceof ApiError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) c.header(name, value)
    return c.json(errorBody(c, error.code, error.message, error.details), error.status)
  }
  if (error instanceof HTTPException) {
    const status = error.status
    const code = status === 413 ? "payload_too_large" : status === 401 ? "unauthorized" : "http_error"
    return c.json(errorBody(c, code, error.message || "Request failed"), status)
  }
  c.get("log").error({ err: error }, "unhandled error")
  return c.json(errorBody(c, "internal", "Something went wrong. Quote the request id if it keeps happening."), 500)
}
