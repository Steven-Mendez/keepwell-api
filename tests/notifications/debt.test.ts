// The "debt" kind (a personal debt due soon, T24) is newer than the apps already installed, like
// "bill": its pushes may only carry what those apps already read, and its target is a screen they
// decode (see bill.test.ts and ADR 0012, "New kinds").
import { describe, expect, it } from "vitest"

import { apnsRequest } from "../../src/adapters/push/apns"
import { webPayload } from "../../src/adapters/push/web-push"
import type { PersonalDebt } from "../../src/core/domain/schema"
import { dueNotifications, NotificationWording } from "../../src/core/notifications/compose"
import { notificationMessage } from "../../src/core/use-cases/send-due-notifications"
import { ledger } from "../support/notifications"

/** The screens a published app decodes from `target` (iOS `LedgerNotification.Target.init(json:)`). */
const SCREENS_INSTALLED_APPS_KNOW = ["transaction", "creditCard", "account", "debts", "recurring", "summary"]

const ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const DEBT = `debt:${ID}:2026-11-15`

const debt = (overrides: Partial<PersonalDebt> = {}): PersonalDebt => ({
  id: ID,
  person: "Ana",
  direction: "theyOweMe",
  amount: { amount: "12", currency: "USD" },
  date: "2026-09-01T18:00:00.000Z",
  repayments: [],
  // Midnight of Nov 15 in Managua, the ledger's home zone.
  dueDate: "2026-11-15T06:00:00.000Z",
  ...overrides,
})

const due = (debts: PersonalDebt[], now: string) =>
  dueNotifications({ ledger: ledger({ personalDebts: debts }), states: { read: new Set(), dismissed: new Set() }, delivered: new Set(), now: new Date(now) })

describe("personal debt reminders", () => {
  it("are sent from 09:00 local, the window's number of days before the due date", () => {
    // 08:00 and 10:00 in Managua on Nov 12, three days before.
    expect(due([debt()], "2026-11-12T14:00:00Z").some((n) => n.kind === "debt")).toBe(false)
    expect(due([debt()], "2026-11-12T16:00:00Z").map((n) => n.id)).toContain(DEBT)
    // Not once it is overdue, nor for a settled debt.
    expect(due([debt()], "2026-11-16T16:00:00Z").some((n) => n.kind === "debt")).toBe(false)
    expect(due([debt({ settledAt: "2026-11-10T18:00:00.000Z" })], "2026-11-12T16:00:00Z").some((n) => n.kind === "debt")).toBe(false)
  })

  it("read in both languages and both directions, and travel only in fields an app that predates the kind already reads", () => {
    const value = ledger({ personalDebts: [debt()] })
    const found = due([debt()], "2026-11-12T16:00:00Z").find((n) => n.kind === "debt")
    expect(found).toBeDefined()
    if (!found) return
    const wording = new NotificationWording(value)
    expect(wording.copy(found, "en")).toMatchObject({ title: "Ana: due in 3 days", body: "They owe you $12.00." })
    expect(wording.copy(found, "es").title).toBe("Ana: vence en 3 días")
    expect(wording.copy(found, "es").body).toMatch(/^Te debe /)

    const owed = due([debt({ direction: "iOwe" })], "2026-11-15T16:00:00Z").find((n) => n.kind === "debt")
    expect(owed && wording.copy(owed, "en")).toMatchObject({ title: "Ana: due today", body: "You owe $12.00." })
    expect(owed && wording.copy(owed, "es").body).toMatch(/^Le debes /)

    const message = notificationMessage(found, wording.copy(found, "en"), 1)
    expect(message).toMatchObject({ title: "Ana: due in 3 days", target: { screen: "debts" } })
    const apns = JSON.parse(apnsRequest("ab".repeat(32), message, "app.keepwell.ios").body) as Record<string, unknown>
    expect(Object.keys(apns).sort()).toEqual(["aps", "notification_id", "target"])
    expect(apns.aps).toEqual({ alert: { title: "Ana: due in 3 days", body: "They owe you $12.00." }, sound: "default", "thread-id": "debt", badge: 1 })
    expect(apns.notification_id).toBe(DEBT)
    expect(apns.target).toEqual({ screen: "debts" })
    expect(SCREENS_INSTALLED_APPS_KNOW).toContain((apns.target as { screen: string }).screen)
    expect(webPayload(message)).toEqual({ type: "notification", id: DEBT, title: "Ana: due in 3 days", body: "They owe you $12.00." })
  })
})
