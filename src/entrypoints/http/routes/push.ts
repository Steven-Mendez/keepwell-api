import { Hono } from "hono"
import { z } from "zod"

import type { Auth } from "../../../adapters/auth/auth"
import { Id } from "../../../core/domain/schema"
import { isTimeZone } from "../../../core/domain/domain"
import type { PushDeviceStore } from "../../../core/ports/push"
import type { ResolveCapabilities } from "../../../core/use-cases/resolve-capabilities"
import { ApiError } from "../errors"
import { requireCapability } from "../middlewares/capability"
import { requireSession } from "../middlewares/session"
import type { AppEnv } from "../types"

/** An APNs device token as the app writes it: lowercase hex, 32 bytes today, Apple allows it to grow. */
const APNS_TOKEN = /^[0-9a-f]{32,200}$/

const isLocale = (tag: string) => {
  try {
    return Intl.getCanonicalLocales(tag).length === 1
  } catch {
    return false
  }
}

function isSubscription(token: string): boolean {
  try {
    const value = JSON.parse(token) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
    return typeof value.endpoint === "string" && value.endpoint.startsWith("https://") && typeof value.keys?.p256dh === "string" && typeof value.keys.auth === "string"
  } catch {
    return false
  }
}

export const DeviceBody = z
  .object({
    platform: z.enum(["ios", "web"]),
    /** iOS: the APNs device token in lowercase hex. Web: `JSON.stringify(subscription.toJSON())`. */
    token: z.string().min(1).max(4096),
    time_zone: z.string().max(64).refine(isTimeZone, "Not an IANA time zone"),
    locale: z.string().max(35).refine(isLocale, "Not a BCP 47 language tag"),
    environment: z.enum(["sandbox", "production"]).optional(),
  })
  .superRefine((body, context) => {
    if (body.platform === "ios" && !APNS_TOKEN.test(body.token)) context.addIssue({ code: "custom", path: ["token"], message: "An iOS token is the APNs device token in lowercase hex" })
    if (body.platform === "web" && !isSubscription(body.token)) context.addIssue({ code: "custom", path: ["token"], message: "A web token is the JSON of a push subscription" })
  })

export const DeviceParams = z.object({ clientId: Id })

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new ApiError(400, "invalid_request", "The request doesn't match the API", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })))
  }
  return parsed.data
}

/** Push registration (ADR 0012). Same gate as sync: the server only knows the ledger of people who sync. */
export function pushRoutes(deps: { auth: Promise<Auth>; capabilities: Promise<ResolveCapabilities>; devices: PushDeviceStore; vapidPublicKey: () => Promise<string | undefined>; now?: () => Date }) {
  const routes = new Hono<AppEnv>()
  routes.use("/push/*", requireSession(deps.auth), requireCapability(deps.capabilities, "cloud_sync"))

  routes.get("/push/config", async (c) => {
    const key = await deps.vapidPublicKey().catch(() => undefined)
    if (!key) throw new ApiError(503, "push_unavailable", "Web notifications aren't set up on this server")
    return c.json({ vapid_public_key: key })
  })

  routes.put("/push/devices/:clientId", async (c) => {
    const { clientId } = parse(DeviceParams, c.req.param())
    const body = parse(DeviceBody, await c.req.json().catch(() => undefined))
    await deps.devices.upsert(
      c.get("user").id,
      { clientId, platform: body.platform, token: body.token, timeZone: body.time_zone, locale: body.locale, environment: body.platform === "ios" ? (body.environment ?? "production") : null },
      (deps.now ?? (() => new Date()))()
    )
    return c.body(null, 204)
  })

  routes.delete("/push/devices/:clientId", async (c) => {
    const { clientId } = parse(DeviceParams, c.req.param())
    await deps.devices.remove(c.get("user").id, clientId)
    return c.body(null, 204)
  })

  return routes
}
