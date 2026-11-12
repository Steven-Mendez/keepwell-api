// The "bill" kind (a recurring expense recorded as a draft, due tomorrow) is newer than the apps
// already installed. They must show and open it without knowing it, so its pushes may only carry
// what those apps already read (ADR 0012, Payloads):
//
// - the web service worker (keepwell-web `src/app/sw.ts`) reads `type`, `id`, `title` and `body`;
//   tapping opens `/notifications?open=<id>`, which marks the id read and falls back to the inbox
//   when it doesn't compute that notification itself;
// - the iPhone (keepwell-ios `NotificationResponder`, `LedgerNotification.Target(userInfo:)`) shows
//   the server's `aps.alert`, reads `notification_id` as an opaque string and decodes `target`,
//   answering nil for a screen it doesn't know. `thread-id` only groups banners.
import { describe, expect, it } from "vitest"

import { apnsRequest } from "../../src/adapters/push/apns"
import { webPayload } from "../../src/adapters/push/web-push"
import type { RecurringRule } from "../../src/core/domain/schema"
import { dueNotifications, NotificationWording } from "../../src/core/notifications/compose"
import { notificationMessage } from "../../src/core/use-cases/send-due-notifications"
import { ledger, VISA } from "../support/notifications"

/** The screens a published app decodes from `target` (iOS `LedgerNotification.Target.init(json:)`). */
const SCREENS_INSTALLED_APPS_KNOW = ["transaction", "creditCard", "account", "debts", "recurring", "summary"]

const rule = (overrides: Partial<RecurringRule> = {}): RecurringRule => ({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Rent",
  kind: "expense",
  categoryId: "housing",
  amount: "450",
  currency: "USD",
  accountId: VISA,
  frequency: "monthly",
  interval: 1,
  startDate: "2026-11-14T15:00:00.000Z",
  nextDate: "2026-11-14T15:00:00.000Z",
  isSubscription: false,
  autoConfirm: false,
  isPaused: false,
  source: "app",
  ...overrides,
})

const BILL = "bill:cccccccc-cccc-4ccc-8ccc-cccccccccccc:2026-11-14"
const due = (rules: RecurringRule[]) =>
  dueNotifications({ ledger: ledger({ recurringRules: rules }), states: { read: new Set(), dismissed: new Set() }, delivered: new Set(), now: new Date("2026-11-13T16:00:00Z") })

describe("bill reminders", () => {
  it("are sent the day before a recurring expense recorded as a draft, from 09:00 local", () => {
    expect(due([rule()]).map((n) => n.id)).toContain(BILL)
    expect(due([rule({ autoConfirm: true })]).some((n) => n.kind === "bill")).toBe(false)
    expect(due([rule({ kind: "income" })]).some((n) => n.kind === "bill")).toBe(false)
    expect(due([rule({ isSubscription: true })]).map((n) => n.id)).toContain(BILL.replace("bill:", "renewal:"))
  })

  it("travel only in fields an app that predates the kind already reads", () => {
    const value = ledger({ recurringRules: [rule()] })
    const bill = due([rule()]).find((n) => n.kind === "bill")
    expect(bill).toBeDefined()
    if (!bill) return
    const wording = new NotificationWording(value)
    expect(wording.copy(bill, "es").title).toBe("Rent vence mañana")
    const message = notificationMessage(bill, wording.copy(bill, "en"), 1)
    expect(message).toMatchObject({ title: "Rent is due tomorrow", target: { screen: "recurring" } })

    const apns = JSON.parse(apnsRequest("ab".repeat(32), message, "app.keepwell.ios").body) as Record<string, unknown>
    expect(Object.keys(apns).sort()).toEqual(["aps", "notification_id", "target"])
    expect(apns.aps).toEqual({ alert: { title: "Rent is due tomorrow", body: expect.any(String) }, sound: "default", "thread-id": "bill", badge: 1 })
    expect(apns.notification_id).toBe(BILL)
    expect(SCREENS_INSTALLED_APPS_KNOW).toContain((apns.target as { screen: string }).screen)

    expect(webPayload(message)).toEqual({ type: "notification", id: BILL, title: "Rent is due tomorrow", body: message.type === "notification" ? message.body : "" })
  })
})
