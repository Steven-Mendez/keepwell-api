import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { signIn, testAuthApp } from "../support/auth"
import { adminDatabase, appDatabase } from "../support/database"
import { event, syncClient, transactionRow, wipe } from "../support/sync"

const T0 = "2026-11-01T10:00:00.000Z"
const T1 = "2026-11-01T11:00:00.000Z"
const T2 = "2026-11-01T12:00:00.000Z"
const MOVEMENT = "55555555-5555-4555-8555-555555555555"
const RULE = "66666666-6666-4666-8666-666666666666"
const CATEGORIZATION = "77777777-7777-4777-8777-777777777777"
const SUBWAY = "88888888-8888-4888-8888-888888888888"
const UBER_EATS = "99999999-9999-4999-8999-999999999999"

function merchantRow(id: string, name: string, at: string, extra: Record<string, unknown> = {}) {
  return { id, name, domain: null, brand_id: null, default_category_id: null, is_platform: false, created_at: T0, updated_at: at, deleted_at: null, ...extra }
}

/** A movement as an app that predates merchants builds it: no merchant keys at all. */
const oldAppMovement = (at: string, description = "Supermercado") => transactionRow(MOVEMENT, at, { created_at: T0, description })
const newAppMovement = (at: string, merchant: string | null, via: string | null) => ({ ...oldAppMovement(at), merchant_id: merchant, via_merchant_id: via })

function recurringRow(at: string, extra: Record<string, unknown> = {}) {
  return {
    id: RULE, name: "Netflix", kind: "expense", category_id: "subscriptions", amount: "9.99", currency: "USD", account_id: "11111111-1111-4111-8111-111111111111",
    card_id: null, destination_account_id: null, frequency: "monthly", interval: 1, start_date: T0, next_date: T0, end_date: null, is_subscription: true,
    auto_confirm: true, is_paused: false, note: null, tags: [], created_at: T0, updated_at: at, deleted_at: null, ...extra,
  }
}

function categorizationRow(at: string, extra: Record<string, unknown> = {}) {
  return { id: CATEGORIZATION, match: "subway", category_id: "restaurants", kind: "expense", tags: [], sort_index: 0, created_at: T0, updated_at: at, deleted_at: null, ...extra }
}

describe("merchants and their links on movements and rules", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function devices() {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    return { web: syncClient(http, cookie), old: syncClient(http, cookie), phone: syncClient(http, cookie) }
  }

  const stored = async (table: string, id: string) => (await admin.db.execute(sql.raw(`select * from ${table} where id = '${id}'`))).rows[0] as Record<string, unknown>

  it("a merchant travels like any synced row: pushed, pulled, in the snapshot, and its tombstone is final", async () => {
    const { web, phone } = await devices()
    const subway = merchantRow(SUBWAY, "Subway", T0, { domain: "subway.com", brand_id: "subway", default_category_id: "restaurants" })
    expect((await web.push([event("merchant", subway, "create")])).body.results[0]).toMatchObject({ status: "applied" })
    expect((await phone.pull(0)).body.changes).toEqual([expect.objectContaining({ entity: "merchant", entity_id: SUBWAY, row: subway })])
    expect((await phone.snapshot("merchant")).body.rows).toEqual([subway])

    await phone.push([event("merchant", { ...subway, updated_at: T1, deleted_at: T1 })])
    const revived = await web.push([event("merchant", { ...subway, name: "Subway!", updated_at: T2 })])
    expect(revived.body.results[0]).toMatchObject({ status: "stale", reason: "tombstone_is_final" })
  })

  it("rejects a merchant that breaks its wire schema", async () => {
    const { web } = await devices()
    const blank = await web.push([event("merchant", merchantRow(SUBWAY, "  ", T0), "create")])
    const badDomain = await web.push([event("merchant", merchantRow(UBER_EATS, "Uber Eats", T0, { domain: "https://ubereats.com" }), "create")])
    expect(blank.body.results[0]!.status).toBe("rejected")
    expect(badDomain.body.results[0]!.status).toBe("rejected")
  })

  it("an app older than merchants editing a movement keeps its business and platform, everywhere", async () => {
    const { web, old, phone } = await devices()
    await web.push([event("transaction", newAppMovement(T0, SUBWAY, UBER_EATS), "create")])

    expect((await old.push([event("transaction", oldAppMovement(T1, "Subway Metrocentro"))])).body.results[0]).toMatchObject({ status: "applied" })
    expect(await stored("transactions", MOVEMENT)).toMatchObject({ description: "Subway Metrocentro", merchant_id: SUBWAY, via_merchant_id: UBER_EATS })
    const pulled = (await phone.pull(0)).body.changes.at(-1)!.row
    expect(pulled).toMatchObject({ description: "Subway Metrocentro", merchant_id: SUBWAY, via_merchant_id: UBER_EATS })
  })

  it("null from a newer app clears a link", async () => {
    const { web, phone } = await devices()
    await web.push([event("transaction", newAppMovement(T0, SUBWAY, UBER_EATS), "create")])
    await phone.push([event("transaction", newAppMovement(T1, SUBWAY, null))])
    expect(await stored("transactions", MOVEMENT)).toMatchObject({ merchant_id: SUBWAY, via_merchant_id: null })
    await phone.push([event("transaction", newAppMovement(T2, null, null))])
    expect(await stored("transactions", MOVEMENT)).toMatchObject({ merchant_id: null, via_merchant_id: null })
  })

  it("recurring and categorization rules keep their merchant when an old app leaves it out, and lose it on null", async () => {
    const { web, old } = await devices()
    await web.push([
      event("recurringRule", recurringRow(T0, { merchant_id: SUBWAY, via_merchant_id: UBER_EATS }), "create"),
      event("categorizationRule", categorizationRow(T0, { merchant_id: SUBWAY }), "create"),
    ])
    await old.push([event("recurringRule", recurringRow(T1, { name: "Netflix HD" })), event("categorizationRule", categorizationRow(T1, { match: "subway metro" }))])
    expect(await stored("recurring_rules", RULE)).toMatchObject({ name: "Netflix HD", merchant_id: SUBWAY, via_merchant_id: UBER_EATS })
    expect(await stored("categorization_rules", CATEGORIZATION)).toMatchObject({ match: "subway metro", merchant_id: SUBWAY })

    await web.push([event("recurringRule", recurringRow(T2, { merchant_id: null, via_merchant_id: null })), event("categorizationRule", categorizationRow(T2, { merchant_id: null }))])
    expect(await stored("recurring_rules", RULE)).toMatchObject({ merchant_id: null, via_merchant_id: null })
    expect(await stored("categorization_rules", CATEGORIZATION)).toMatchObject({ merchant_id: null })
  })
})
