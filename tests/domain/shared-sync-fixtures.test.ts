import { describe, expect, it } from "vitest"

import ids from "../../src/core/domain/fixtures/ids.json"
import sync from "../../src/core/domain/fixtures/sync.json"
import { legacyRepaymentId, loanPaymentId, occurrenceId, uuidV5, validateSyncEvent } from "../../src/core/domain/schema"

// The same vectors and events keepwell-web and keepwell-ios run.
describe("shared id vectors", () => {
  it.each(ids.uuidV5.map((c) => [c.name, c] as const))("uuidV5(%s)", (_, c) => {
    expect(uuidV5(c.name, c.namespace)).toBe(c.id)
  })
  it("occurrence, loan payment and legacy repayment ids", () => {
    for (const c of ids.occurrences) expect(occurrenceId(c.rule, c.index)).toBe(c.id)
    for (const c of ids.loanPayments) expect(loanPaymentId(c.loanId, c.number)).toBe(c.id)
    for (const c of ids.legacyRepayments) expect(legacyRepaymentId(c.debtId, c.index, c.date, c.amount)).toBe(c.id)
  })
})

describe("shared sync events", () => {
  it.each(sync.valid.map((c) => [c.name, c] as const))("accepts %s", (_, c) => {
    expect(validateSyncEvent(c.event).ok).toBe(true)
  })
  it.each(sync.invalid.map((c) => [c.name, c] as const))("rejects %s", (_, c) => {
    expect(validateSyncEvent(c.event).ok).toBe(false)
  })
})
