import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { adminDatabase, appDatabase } from "../support/database"
import { signIn, testAuthApp } from "../support/auth"

describe("passkeys", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(async () => {
    for (const table of ["sessions", "accounts", "users", "audit_log", "passkeys"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  it("offers registration to a signed-in person, with the web app's host as relying party", async () => {
    const { app: http } = testAuthApp(app.db)
    const { cookie } = await signIn(http, "000001.author")
    const res = await http.request("/api/auth/passkey/generate-register-options", { headers: { cookie } })
    expect(res.status).toBe(200)
    const options = (await res.json()) as { rp: { id: string; name: string }; challenge: string; authenticatorSelection?: Record<string, unknown> }
    expect(options.rp).toEqual({ id: "localhost", name: "Keepwell" })
    expect(options.challenge.length).toBeGreaterThan(16)
  })

  it("refuses registration without a session", async () => {
    const { app: http } = testAuthApp(app.db)
    expect((await http.request("/api/auth/passkey/generate-register-options")).status).toBe(401)
  })

  it("offers authentication options to anyone, for the passkey sign-in button", async () => {
    const { app: http } = testAuthApp(app.db)
    const res = await http.request("/api/auth/passkey/generate-authenticate-options", { headers: { origin: "http://localhost:3000" } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { rpId: string }).rpId).toBe("localhost")
  })
})
