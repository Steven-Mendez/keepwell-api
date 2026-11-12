import { describe, expect, it } from "vitest"

import type { LedgerRows } from "../../src/core/ledger/wire-to-domain"
import type { LedgerReader } from "../../src/core/ports/ledger-reader"
import type { ApplySyncBatch } from "../../src/core/use-cases/apply-sync-batch"
import { defaultTimeZone, ReadLedger } from "../../src/core/use-cases/read-ledger"

const settingsRow = (timeZone: string | null | undefined) => ({
  id: "settings",
  principal: "USD",
  second: null,
  rate: "1",
  payment_reminder_days_before: 3,
  has_completed_onboarding: true,
  ...(timeZone === undefined ? {} : { time_zone: timeZone }),
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  deleted_at: null,
})

function readLedger(device: string | undefined) {
  const reader: LedgerReader = { load: async () => ({}) as LedgerRows, latestDeviceTimeZone: async () => device }
  return new ReadLedger(reader, {} as ApplySyncBatch, "America/Managua")
}

const rows = (timeZone: string | null | undefined) => ({ settings: [settingsRow(timeZone)] }) as unknown as LedgerRows

describe("the zone the server reads a person's days in", () => {
  it("is the home zone in their settings, over their devices'", async () => {
    expect(await readLedger("Asia/Tokyo").timeZone("u", rows("Europe/Madrid"))).toBe("Europe/Madrid")
  })

  it("without one, is their most recently seen device's, the zone their own app computes in", async () => {
    expect(await readLedger("Asia/Tokyo").timeZone("u", rows(null))).toBe("Asia/Tokyo")
    expect(await readLedger("Asia/Tokyo").timeZone("u", rows(undefined))).toBe("Asia/Tokyo")
    expect(await readLedger("Asia/Tokyo").timeZone("u", rows("Mars/Olympus"))).toBe("Asia/Tokyo")
  })

  it("without either, is the deployment's default, never the process's", async () => {
    expect(await readLedger(undefined).timeZone("u", rows(null))).toBe("America/Managua")
    expect(await readLedger("Mars/Olympus").timeZone("u", { settings: [] } as unknown as LedgerRows)).toBe("America/Managua")
    expect(defaultTimeZone({ KEEPWELL_TIME_ZONE: "Europe/Madrid" })).toBe("Europe/Madrid")
    expect(defaultTimeZone({})).toBe("America/Managua")
    expect(defaultTimeZone({ KEEPWELL_TIME_ZONE: "Mars/Olympus" })).toBe("UTC")
  })
})
