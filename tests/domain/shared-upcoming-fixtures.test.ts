import { describe, expect, it } from "vitest"

import { upcomingPayments } from "../../src/core/domain/domain"
import fixtures from "../../src/core/domain/fixtures/upcoming.json"
import type { UpcomingFixtures } from "../../src/core/domain/fixtures"
import { upcomingFixtureLedger } from "../support/upcoming"

// The same cases keepwell-web and keepwell-ios run for upcomingPayments. If this fails after a fresh
// copy, the copy is out of date with the web; if it fails without one, someone edited the copy.
const data = fixtures as UpcomingFixtures

describe("shared upcoming fixtures", () => {
  for (const entry of data.cases) {
    for (const window of entry.windows) {
      it(`${entry.name}, ${window.days} days`, () => {
        const payments = upcomingPayments(upcomingFixtureLedger(entry), new Date(entry.now), window.days)
        expect(payments.map(({ id, status }) => ({ id, status }))).toEqual(window.expected)
      })
    }
  }
})
