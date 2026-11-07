import { Hono } from "hono"
import { z } from "zod"

import type { Auth } from "../../../adapters/auth/auth"
import { IdempotencyKeyReuse } from "../../../core/ports/app-store"
import { PurchaseError, type HandleAppStoreNotification, type RedeemPurchase } from "../../../core/use-cases/redeem-purchase"
import { ApiError } from "../errors"
import { requireSession } from "../middlewares/session"
import type { AppEnv } from "../types"

const RedeemBody = z.object({ signed_transaction: z.string().min(20).max(20_000) })
const NotificationBody = z.object({ signedPayload: z.string().min(20).max(100_000) })

const STATUS: Record<PurchaseError["code"], 400 | 409 | 422> = {
  invalid_purchase: 400,
  unknown_product: 422,
  wrong_environment: 422,
  revoked: 409,
  already_redeemed_elsewhere: 409,
}

export function appStoreRoutes(deps: { auth: Promise<Auth>; redeem: Promise<RedeemPurchase>; notifications: Promise<HandleAppStoreNotification> }) {
  const routes = new Hono<AppEnv>()

  routes.post("/entitlements/app-store", requireSession(deps.auth), async (c) => {
    const key = c.req.header("idempotency-key")
    if (!key || !z.string().uuid().safeParse(key).success) {
      throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (a UUID) and reuse it on retries.")
    }
    const body = RedeemBody.safeParse(await c.req.json().catch(() => undefined))
    if (!body.success) throw new ApiError(400, "invalid_request", "Send signed_transaction, the JWS StoreKit returned.")
    try {
      const answer = await (await deps.redeem).execute({ userId: c.get("user").id, signedTransaction: body.data.signed_transaction, idempotencyKey: key.toLowerCase() })
      return c.json(answer.body as Record<string, unknown>, answer.status as 200 | 409)
    } catch (error) {
      if (error instanceof PurchaseError) throw new ApiError(STATUS[error.code], error.code, error.message)
      if (error instanceof IdempotencyKeyReuse) throw new ApiError(422, "idempotency_key_reused", error.message)
      throw error
    }
  })

  // No session: Apple calls this. Trust comes from the signature, checked against Apple's root.
  routes.post("/webhooks/app-store", async (c) => {
    const body = NotificationBody.safeParse(await c.req.json().catch(() => undefined))
    if (!body.success) throw new ApiError(400, "invalid_request", "Expected an App Store Server Notification V2.")
    try {
      const outcome = await (await deps.notifications).execute(body.data.signedPayload)
      c.get("log").info({ metric: "app_store_notification", applied: outcome.applied }, "app store notification")
      return c.json({ received: true })
    } catch (error) {
      if (error instanceof PurchaseError) throw new ApiError(400, error.code, error.message)
      throw error
    }
  })
  return routes
}
