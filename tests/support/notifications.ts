import type { Ledger } from "../../src/core/domain/domain"
import { DEFAULT_SETTINGS } from "../../src/core/domain/schema"
import type { LedgerRows } from "../../src/core/ledger/wire-to-domain"
import type { DeliveryStore, NewPushDevice, PushDevice, PushDeviceStore, PushMessage, PushSender, SendResult } from "../../src/core/ports/push"
import type { JobLog } from "../../src/core/use-cases/send-due-notifications"
import type { ReadLedger } from "../../src/core/use-cases/read-ledger"

export const VISA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const GROCERIES = "groceries"

export const silentLog: JobLog = { info() {}, warn() {}, error() {} }

/**
 * A small ledger: a credit account closing on the 13th and due on the 15th (payment reminders start
 * three days before), a groceries budget of 100 with 85 spent in November, and a draft dated Nov 13.
 */
export function ledger(extra: Partial<Ledger> = {}): Ledger {
  return {
    settings: DEFAULT_SETTINGS,
    accounts: [{ id: VISA, name: "Visa", kind: "credit", openingBalances: [], openingDate: "2026-01-01T00:00:00.000Z", creditTerms: { debtMode: "principal", cutoffDay: 13, dueDay: 15 } }],
    cards: [],
    categories: [{ id: GROCERIES, name: "Groceries", kind: "expense", isRenamed: false, monthlyBudget: { amount: "100", currency: "USD" } }],
    transactions: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        date: "2026-11-12T12:00:00.000Z",
        status: "confirmed",
        description: "Market",
        kind: "expense",
        categoryId: GROCERIES,
        amount: "85",
        currency: "USD",
        accountId: VISA,
        exchangeRate: { principal: "USD", second: "USD", rate: "1" },
        isShared: false,
      },
    ],
    recurringRules: [],
    savingsGoals: [],
    loans: [],
    personalDebts: [],
    categorizationRules: [],
    ...extra,
  }
}

export const noStates: LedgerRows["notificationState"] = []

export function stateRow(id: string, extra: Partial<LedgerRows["notificationState"][number]> = {}): LedgerRows["notificationState"][number] {
  return { id, read_at: null, dismissed_at: null, created_at: "2026-11-13T00:00:00.000Z", updated_at: "2026-11-13T00:00:00.000Z", deleted_at: null, ...extra }
}

/** A ReadLedger that answers with a fixed ledger and states. */
export function fakeLedger(value: Ledger, states: LedgerRows["notificationState"] = []): ReadLedger {
  return { load: async () => ({ ledger: value, rows: { notificationState: states } as LedgerRows, fresh: true }) } as unknown as ReadLedger
}

export function device(extra: Partial<PushDevice> = {}): PushDevice {
  return {
    id: "device-1",
    userId: "user-1",
    clientId: "client-1",
    platform: "ios",
    token: "ab".repeat(32),
    timeZone: "UTC",
    locale: "en-US",
    environment: "production",
    lastSeenAt: new Date("2026-11-13T00:00:00Z"),
    ...extra,
  }
}

/** In-memory stores with the same contract as the database ones. */
export class MemoryStores implements PushDeviceStore, DeliveryStore {
  devices: PushDevice[] = []
  deliveries = new Map<string, Date>()
  pruned: Date[] = []

  async upsert(userId: string, input: NewPushDevice, at: Date) {
    this.devices = this.devices.filter((d) => !(d.userId === userId && d.clientId === input.clientId))
    this.devices.push({ id: `${userId}:${input.clientId}`, userId, ...input, lastSeenAt: at })
  }
  async remove(userId: string, clientId: string) {
    this.devices = this.devices.filter((d) => !(d.userId === userId && d.clientId === clientId))
  }
  async removeWithToken(userId: string, clientId: string, token: string) {
    this.devices = this.devices.filter((d) => !(d.userId === userId && d.clientId === clientId && d.token === token))
  }
  async list(userId: string) {
    return this.devices.filter((d) => d.userId === userId)
  }
  async usersWithDevices() {
    return [...new Set(this.devices.map((d) => d.userId))]
  }
  async claim(userId: string, id: string, at: Date) {
    const key = `${userId}|${id}`
    if (this.deliveries.has(key)) return false
    this.deliveries.set(key, at)
    return true
  }
  async release(userId: string, id: string) {
    this.deliveries.delete(`${userId}|${id}`)
  }
  async prune(before: Date) {
    this.pruned.push(before)
    return 0
  }
}

/** A sender that records what it was asked and answers per client id. */
export class RecordingSender implements PushSender {
  calls: { device: PushDevice; message: PushMessage }[] = []
  outcomes = new Map<string, SendResult>()
  async send(device: PushDevice, message: PushMessage): Promise<SendResult> {
    this.calls.push({ device, message })
    return this.outcomes.get(device.clientId) ?? "sent"
  }
  get notifications() {
    return this.calls.filter((c) => c.message.type === "notification")
  }
}
