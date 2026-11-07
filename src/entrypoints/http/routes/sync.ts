import { Hono } from "hono"
import { z } from "zod"

import type { Auth } from "../../../adapters/auth/auth"
import { Id, SyncEntity } from "../../../core/domain/schema"
import type { SyncRepository } from "../../../core/ports/sync-repository"
import { ApplySyncBatch, MAX_PUSH_EVENTS } from "../../../core/use-cases/apply-sync-batch"
import type { ResolveCapabilities } from "../../../core/use-cases/resolve-capabilities"
import { ApiError } from "../errors"
import { requireCapability } from "../middlewares/capability"
import { requireSession } from "../middlewares/session"
import type { AppEnv } from "../types"
import type { SwitchesSource } from "../../../core/switches"
import { refuseWhenReadOnly } from "../middlewares/switches"

export const MAX_PAGE = 500
/** Leave room under the Lambda's 25 s for answering with what committed. */
export const PUSH_BUDGET_MS = 20_000

export const PushBody = z.object({
  client_id: Id,
  platform: z.enum(["ios", "web", "other"]),
  /** Validated one by one by the use case: a bad event must not fail the request. */
  events: z.array(z.unknown()).max(MAX_PUSH_EVENTS),
})

export const PullQuery = z.object({
  client_id: Id,
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(MAX_PAGE),
})

export const SnapshotQuery = z.object({
  entity: SyncEntity,
  after: z.string().max(64).default(""),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(MAX_PAGE),
})

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new ApiError(400, "invalid_request", "The request doesn't match the API", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })))
  }
  return parsed.data
}

export function syncRoutes(deps: { auth: Promise<Auth>; capabilities: Promise<ResolveCapabilities>; repository: SyncRepository; clock?: () => number; switches?: SwitchesSource }) {
  const clock = deps.clock ?? (() => Date.now())
  const push = new ApplySyncBatch(deps.repository, clock)
  const routes = new Hono<AppEnv>()
  routes.use("/sync/*", requireSession(deps.auth), requireCapability(deps.capabilities, "cloud_sync"))

  if (deps.switches) routes.use("/sync/push", refuseWhenReadOnly(deps.switches))
  routes.post("/sync/push", async (c) => {
    const body = parse(PushBody, await c.req.json().catch(() => undefined))
    const outcome = await push.execute({
      userId: c.get("user").id,
      clientId: body.client_id,
      platform: body.platform,
      events: body.events,
      deadline: clock() + PUSH_BUDGET_MS,
    })
    // Counts only: what happened, never what the rows contain.
    c.get("log").info({ metric: "sync_push", events: body.events.length, partial: outcome.partial, ...outcome.metrics }, "push")
    return c.json({ results: outcome.results, partial: outcome.partial })
  })

  routes.get("/sync/pull", async (c) => {
    const query = parse(PullQuery, c.req.query())
    const { changes, nextCursor } = await deps.repository.pull(c.get("user").id, query.cursor, query.limit)
    return c.json({
      changes: changes.map((change) => ({ server_seq: change.serverSeq, entity: change.entity, entity_id: change.entityId, operation: change.operation, row: change.row })),
      next_cursor: nextCursor,
      has_more: nextCursor > query.cursor && (await moreAfter(deps.repository, c.get("user").id, nextCursor)),
    })
  })

  routes.get("/sync/snapshot", async (c) => {
    const query = parse(SnapshotQuery, c.req.query())
    const { rows, serverSeq } = await deps.repository.snapshot(c.get("user").id, query.entity, query.after, query.limit)
    return c.json({ entity: query.entity, rows, server_seq: serverSeq, next_after: rows.length === query.limit ? rows[rows.length - 1]!.id : null })
  })

  return routes
}

async function moreAfter(repository: SyncRepository, userId: string, cursor: number): Promise<boolean> {
  const { nextCursor } = await repository.pull(userId, cursor, 1)
  return nextCursor > cursor
}
