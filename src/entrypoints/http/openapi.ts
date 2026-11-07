import { z } from "zod"

import { SYNC_WIRE, SyncEvent } from "../../core/domain/schema"
import { PullQuery, PushBody, SnapshotQuery } from "./routes/sync"

// OpenAPI 3.1 generated from the Zod schemas that validate requests, so the document can't
// describe an API other than the one that runs. `pnpm openapi` writes docs/openapi.json; a test
// fails when the committed file is out of date.

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const content = (schema: unknown) => ({ "application/json": { schema } })

const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
  request_id: z.string(),
})

const PushResult = z.object({
  event_id: z.string(),
  status: z.enum(["applied", "stale", "rejected"]),
  reason: z.string().optional(),
  server_seq: z.number().int().optional(),
  updated_at: z.string().optional(),
  current: z.record(z.string(), z.unknown()).optional(),
})

const errors = {
  "400": { description: "The request doesn't match the API", content: content(ref("Error")) },
  "401": { description: "No valid session", content: content(ref("Error")) },
  "403": { description: "`needs_plan`: the capability named in `details.capability` is missing", content: content(ref("Error")) },
}

function queryParameters(schema: z.ZodObject) {
  return Object.entries(schema.shape).map(([name, field]) => ({
    name,
    in: "query",
    required: !(field as z.ZodType).safeParse(undefined).success,
    schema: json(field as z.ZodType),
  }))
}

export function openApiDocument() {
  const rows = Object.fromEntries(Object.entries(SYNC_WIRE).map(([entity, wire]) => [`Row.${entity}`, json(wire)]))
  return {
    openapi: "3.1.0",
    info: {
      title: "Keepwell API",
      version: "1",
      description: "Sync for the Keepwell apps and the account behind it. The MCP server lives at /mcp. See docs/adr.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: { session: { type: "apiKey", in: "cookie", name: "__Secure-better-auth.session_token" } },
      schemas: { Error: json(ErrorBody), SyncEvent: json(SyncEvent), PushResult: json(PushResult), ...rows },
    },
    security: [{ session: [] }],
    paths: {
      "/health": { get: { security: [], summary: "Liveness, version and dependencies", responses: { "200": { description: "Healthy" }, "503": { description: "A dependency is down" } } } },
      "/me": {
        get: { summary: "The signed-in person, their plan and capabilities", responses: { "200": { description: "OK" }, "401": errors["401"] } },
        delete: { summary: "Delete the account: sessions end now, data is erased in the background", responses: { "202": { description: "Deletion requested" }, "401": errors["401"] } },
      },
      "/sync/push": {
        post: {
          summary: "Send up to 200 outbox events; each is applied, stale or rejected on its own",
          requestBody: { required: true, content: content({ ...json(PushBody), properties: { ...(json(PushBody).properties as object), events: { type: "array", maxItems: 200, items: ref("SyncEvent") } } }) },
          responses: { "200": { description: "One result per event, in order", content: content({ type: "object", properties: { results: { type: "array", items: ref("PushResult") }, partial: { type: "boolean" } } }) }, ...errors },
        },
      },
      "/sync/pull": {
        get: { summary: "Changes after a cursor, oldest first", parameters: queryParameters(PullQuery), responses: { "200": { description: "A page of changes and the next cursor" }, ...errors } },
      },
      "/sync/snapshot": {
        get: { summary: "Current rows of one entity, by id, and the sequence they reflect", parameters: queryParameters(SnapshotQuery), responses: { "200": { description: "A page of rows" }, ...errors } },
      },
    },
  }
}
