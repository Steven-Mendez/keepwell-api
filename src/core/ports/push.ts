import type { NotificationTarget } from "../domain/domain"

export type PushPlatform = "ios" | "web"

/** One installation a person can be pushed to (ADR 0012). */
export interface PushDevice {
  id: string
  userId: string
  clientId: string
  platform: PushPlatform
  /** The APNs device token (lowercase hex), or the Web Push subscription as JSON text. */
  token: string
  /** IANA name the device reported. */
  timeZone: string
  /** BCP 47 tag the device reported. */
  locale: string
  /** APNs only. */
  environment: "sandbox" | "production" | null
  lastSeenAt: Date
}

export type NewPushDevice = Pick<PushDevice, "clientId" | "platform" | "token" | "timeZone" | "locale" | "environment">

export interface PushDeviceStore {
  /** Registers or refreshes the device under (user, client id); also marks it seen. */
  upsert(userId: string, device: NewPushDevice, at: Date): Promise<void>
  remove(userId: string, clientId: string): Promise<void>
  /** Removes it only while it still holds `token`: a device that registered again keeps its new one. */
  removeWithToken(userId: string, clientId: string, token: string): Promise<void>
  list(userId: string): Promise<PushDevice[]>
  /** Every user with at least one device (the job's work list). */
  usersWithDevices(): Promise<string[]>
}

/** Idempotency for the job: a notification is pushed once per user (`notification_deliveries`). */
export interface DeliveryStore {
  /** True when this call recorded the delivery, false when it already existed. */
  claim(userId: string, notificationId: string, at: Date): Promise<boolean>
  /** Forgets a claim whose send failed everywhere, so the next run tries again. */
  release(userId: string, notificationId: string): Promise<void>
  /** Deletes deliveries older than `before`, for every user. */
  prune(before: Date): Promise<number>
}

export type PushMessage =
  | {
      type: "notification"
      id: string
      kind: string
      title: string
      body: string
      target: NotificationTarget
      /** The unread count the iPhone's icon shows. */
      badge: number
      /** Drafts only: the transaction the "Confirm" / "Postpone" actions act on. */
      transactionId?: string
    }
  | { type: "clear"; ids: string[]; badge: number }

/** `gone`: the push service says this token is dead for good; the device should be deleted. */
export type SendResult = "sent" | "gone" | "failed"

/**
 * How long after a device last registered a `gone` is not believed. A subscription made seconds ago
 * can be refused for a moment, and deleting it would silence that browser until it next loads
 * Keepwell. A device really gone stays skipped and is deleted on the first send after this.
 */
export const GONE_GRACE_MS = 60 * 60 * 1000

/** Whether a device its push service called `gone` should be deleted now. */
export function forgetGoneDevice(device: Pick<PushDevice, "lastSeenAt">, now: Date): boolean {
  return now.getTime() - device.lastSeenAt.getTime() >= GONE_GRACE_MS
}

export interface PushSender {
  send(device: PushDevice, message: PushMessage): Promise<SendResult>
}

/** Public configuration for the web client (`GET /push/config`); undefined when Web Push is off. */
export interface PushConfig {
  vapidPublicKey: string | undefined
}
