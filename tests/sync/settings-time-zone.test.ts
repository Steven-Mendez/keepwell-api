import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { SettingsWire } from "../../src/core/domain/schema"
import { signIn, testAuthApp } from "../support/auth"
import { adminDatabase, appDatabase } from "../support/database"
import { event, syncClient, wipe } from "../support/sync"

const T0 = "2026-11-01T10:00:00.000Z"
const T1 = "2026-11-01T11:00:00.000Z"
const T2 = "2026-11-01T12:00:00.000Z"

/** The settings row as an app that predates `time_zone` builds it: the key isn't there at all. */
function oldAppSettings(at: string, rate: string) {
  return { id: "settings", principal: "USD", second: "NIO", rate, payment_reminder_days_before: 3, has_completed_onboarding: true, created_at: T0, updated_at: at, deleted_at: null }
}

function newAppSettings(at: string, timeZone: string | null, rate = "36.6243") {
  return { ...oldAppSettings(at, rate), time_zone: timeZone }
}

/** What an app older than the column validates a pulled settings row with. */
const OldSettingsWire = SettingsWire.omit({ time_zone: true })

describe("settings time zone and apps that predate it (receta, paso 4)", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(() => wipe(admin.db))

  async function devices() {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    return { phone: syncClient(http, cookie), old: syncClient(http, cookie), web: syncClient(http, cookie) }
  }

  it("an old app ignores the zone it receives", async () => {
    const { phone, old } = await devices()
    await phone.push([event("settings", newAppSettings(T0, "Europe/Madrid"), "create")])
    const pulled = (await old.pull(0)).body.changes.at(-1)!.row
    expect(pulled.time_zone).toBe("Europe/Madrid")
    const parsed = OldSettingsWire.safeParse(pulled)
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty("time_zone")
  })

  it("an old app resending the settings row keeps the zone, in the database and for every other device", async () => {
    const { phone, old, web } = await devices()
    await phone.push([event("settings", newAppSettings(T0, "Europe/Madrid"), "create")])

    const resent = await old.push([event("settings", oldAppSettings(T1, "37.0000"))])
    expect(resent.body.results[0]).toMatchObject({ status: "applied" })

    const [stored] = (await admin.db.execute(sql`select rate, time_zone from settings`)).rows
    expect(stored).toEqual({ rate: "37.0000", time_zone: "Europe/Madrid" })

    const changes = (await web.pull(0)).body.changes.filter((change) => change.entity === "settings")
    expect(changes.at(-1)!.row).toMatchObject({ rate: "37.0000", time_zone: "Europe/Madrid" })
    const [logged] = (await admin.db.execute(sql`select payload from change_log order by server_seq desc limit 1`)).rows
    expect(JSON.parse(logged!.payload as string)).toMatchObject({ rate: "37.0000", time_zone: "Europe/Madrid" })

    expect((await web.snapshot("settings")).body.rows[0]).toMatchObject({ rate: "37.0000", time_zone: "Europe/Madrid" })
  })

  it("a newer app can still change the zone, or clear it with null", async () => {
    const { phone, web } = await devices()
    await phone.push([event("settings", newAppSettings(T0, "Europe/Madrid"), "create")])
    await web.push([event("settings", newAppSettings(T1, "Asia/Tokyo"))])
    expect((await admin.db.execute(sql`select time_zone from settings`)).rows[0]).toEqual({ time_zone: "Asia/Tokyo" })
    await web.push([event("settings", newAppSettings(T2, null))])
    expect((await admin.db.execute(sql`select time_zone from settings`)).rows[0]).toEqual({ time_zone: null })
  })

  it("an old app's row that loses keeps nothing of its own", async () => {
    const { phone, old } = await devices()
    await phone.push([event("settings", newAppSettings(T1, "Europe/Madrid"), "create")])
    const { body } = await old.push([event("settings", oldAppSettings(T0, "37.0000"))])
    expect(body.results[0]).toMatchObject({ status: "stale", current: { time_zone: "Europe/Madrid" } })
    expect((await admin.db.execute(sql`select rate, time_zone from settings`)).rows[0]).toEqual({ rate: "36.6243", time_zone: "Europe/Madrid" })
  })
})
