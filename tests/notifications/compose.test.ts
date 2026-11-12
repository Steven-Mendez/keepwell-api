import { describe, expect, it } from "vitest"

import { dueNotifications, localeOf, NotificationWording, statesOf, unreadCount } from "../../src/core/notifications/compose"
import { inTimeZone, isTimeZone, resolveTimeZone } from "../../src/core/notifications/time-zone"
import { ledger, noStates, stateRow, VISA } from "../support/notifications"
import { ledgerNotifications } from "../../src/core/domain/domain"

const none = { read: new Set<string>(), dismissed: new Set<string>() }
const due = (now: string, zone: string, extra: Partial<Parameters<typeof dueNotifications>[0]> = {}) =>
  dueNotifications({ ledger: ledger(), states: none, delivered: new Set(), now: new Date(now), zone, ...extra }).map((n) => n.id)

describe("time zones", () => {
  it("switches the process zone for the calculation and restores it", () => {
    const before = process.env.TZ
    const hours = inTimeZone("Asia/Tokyo", () => new Date("2026-11-13T00:30:00Z").getHours())
    expect(hours).toBe(9)
    expect(process.env.TZ).toBe(before)
    expect(() =>
      inTimeZone("Asia/Tokyo", () => {
        throw new Error("boom")
      })
    ).toThrow("boom")
    expect(process.env.TZ).toBe(before)
  })

  it("falls back to UTC for a name it doesn't know, never to the server's zone", () => {
    expect(isTimeZone("America/Managua")).toBe(true)
    expect(isTimeZone("Mars/Olympus")).toBe(false)
    expect(resolveTimeZone("Mars/Olympus")).toBe("UTC")
    expect(inTimeZone("Mars/Olympus", () => new Date("2026-11-13T10:00:00Z").getHours())).toBe(10)
  })

  it("names the day by the device's calendar: the same instant is a different day in each zone", () => {
    // 2026-11-13 10:00 UTC. The credit account closes on the 13th.
    const instant = "2026-11-13T10:00:00Z"
    const cutoff = `cutoff:${VISA}:2026-11-13`
    expect(due(instant, "Pacific/Auckland")).toContain(cutoff) // 23:00 on the 13th
    expect(due(instant, "Pacific/Kiritimati")).not.toContain(cutoff) // already the 14th
    expect(due(instant, "Pacific/Pago_Pago")).not.toContain(cutoff) // still the 12th
    expect(inTimeZone("Pacific/Pago_Pago", () => ledgerNotifications(ledger(), new Date(instant)).map((n) => n.id))).toContain(`payment:${VISA}:2026-11-15`)
  })
})

describe("dueNotifications", () => {
  const instant = "2026-11-13T10:00:00Z"

  it("waits for 09:00 local on dated kinds", () => {
    // Los Angeles is UTC-8 in November: 02:00 on the 13th.
    expect(due(instant, "America/Los_Angeles").filter((id) => id.startsWith("cutoff:") || id.startsWith("payment:"))).toEqual([])
    // Tokyo, 19:00 the same day.
    expect(due(instant, "Asia/Tokyo")).toEqual(expect.arrayContaining([`cutoff:${VISA}:2026-11-13`, `payment:${VISA}:2026-11-15`]))
    // The boundary: 08:59 no, 09:00 yes (Tokyo is UTC+9).
    const payment = `payment:${VISA}:2026-11-15`
    expect(due("2026-11-13T23:59:00Z", "Asia/Tokyo")).not.toContain(payment) // 08:59 on the 14th
    expect(due("2026-11-14T00:00:00Z", "Asia/Tokyo")).toContain(payment) // 09:00
  })

  it("sends budget notifications the first time they are seen, whatever the hour", () => {
    expect(due(instant, "America/Los_Angeles")).toEqual(["budget:groceries:2026-11:near"])
  })

  it("leaves out what was read or deleted on any device, and what was delivered", () => {
    const cutoff = `cutoff:${VISA}:2026-11-13`
    const states = statesOf([stateRow(cutoff, { read_at: "2026-11-13T01:00:00Z" }), stateRow("budget:groceries:2026-11:near", { dismissed_at: "2026-11-13T01:00:00Z" }), stateRow(`payment:${VISA}:2026-11-15`, { deleted_at: "2026-11-13T01:00:00Z", read_at: "2026-11-13T01:00:00Z" })])
    const ids = due(instant, "Asia/Tokyo", { states })
    expect(ids).not.toContain(cutoff)
    expect(ids).not.toContain("budget:groceries:2026-11:near")
    // A tombstoned state row says nothing.
    expect(ids).toContain(`payment:${VISA}:2026-11-15`)
    expect(due(instant, "Asia/Tokyo", { delivered: new Set([`payment:${VISA}:2026-11-15`]) })).not.toContain(`payment:${VISA}:2026-11-15`)
  })

  it("counts unread like the inbox: no drafts, no read, no deleted", () => {
    const now = new Date("2026-11-13T10:00:00Z")
    const draft = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      date: "2026-11-13T00:00:00.000Z",
      status: "planned" as const,
      description: "Rent",
      kind: "expense" as const,
      amount: "50",
      currency: "USD",
      accountId: VISA,
      exchangeRate: { principal: "USD", second: "USD", rate: "1" },
      isShared: false,
    }
    const withDraft = ledger({ transactions: [draft, ...ledger().transactions] })
    expect(inTimeZone("Asia/Tokyo", () => ledgerNotifications(withDraft, now).some((n) => n.kind === "planned"))).toBe(true)
    // payment + cutoff + budget; the draft isn't counted.
    expect(unreadCount(withDraft, none, now, "Asia/Tokyo")).toBe(3)
    expect(unreadCount(withDraft, statesOf([stateRow(`cutoff:${VISA}:2026-11-13`, { read_at: "x" })]), now, "Asia/Tokyo")).toBe(2)
    expect(unreadCount(withDraft, statesOf([stateRow(`cutoff:${VISA}:2026-11-13`, { dismissed_at: "x" })]), now, "Asia/Tokyo")).toBe(2)
    expect(statesOf(noStates).read.size).toBe(0)
  })
})

describe("wording", () => {
  it("picks Spanish for es*, English for everything else", () => {
    expect(["es", "es-NI", "es_MX", "ES-ar"].map(localeOf)).toEqual(["es", "es", "es", "es"])
    expect(["en-US", "fr", "esperanto", ""].map(localeOf)).toEqual(["en", "en", "en", "en"])
  })

  it("words a notification with the apps' catalogs, in the device's language", () => {
    const l = ledger()
    const now = new Date("2026-11-13T10:00:00Z")
    const payment = inTimeZone("Asia/Tokyo", () => ledgerNotifications(l, now).find((n) => n.kind === "payment")!)
    const wording = new NotificationWording(l, "Asia/Tokyo")
    const en = wording.copy(payment, "en")
    const es = wording.copy(payment, "es")
    expect(en.title).toBe("Visa: payment in 2 days")
    expect(en.body).toBe("Pay before day 15 so it doesn't generate interest.")
    expect(es.title).not.toBe(en.title)
    expect(es.title).toContain("Visa")
  })

  it("shows amounts, as a push to one's own device does", () => {
    const l = ledger()
    const budget = inTimeZone("UTC", () => ledgerNotifications(l, new Date("2026-11-13T10:00:00Z")).find((n) => n.kind === "budget")!)
    expect(new NotificationWording(l, "UTC").copy(budget, "en")).toMatchObject({ title: "Groceries is close to its budget" })
    expect(new NotificationWording(l, "UTC").copy(budget, "en").body).not.toContain("••••")
  })
})
