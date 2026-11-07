import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { adminDatabase, appDatabase } from "../support/database"
import { signIn, testAuthApp } from "../support/auth"

describe("Sign in with Apple, closed registration", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(async () => {
    for (const table of ["sessions", "accounts", "users", "audit_log"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  it("lets an allowed Apple ID in, sets the session cookie, and /me returns the user", async () => {
    const { app: http } = testAuthApp(app.db)
    const { res, cookie } = await signIn(http, "000001.author")
    expect(res.status).toBe(200)
    expect(cookie).toContain("better-auth.session_token=")

    const me = await http.request("/me", { headers: { cookie } })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: { id: string; email: string } }
    expect(body.user.email).toBe("000001.author@privaterelay.appleid.com")
  })

  it("rejects any other Apple ID with a clear reason, writes no account, and records the attempt", async () => {
    const { app: http } = testAuthApp(app.db)
    const { res, cookie } = await signIn(http, "999999.stranger")
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).toContain("invite-only")
    expect(cookie).not.toContain("session_token")

    expect((await admin.db.execute(sql`select id from users`)).rows).toEqual([])
    const audit = (await admin.db.execute<{ action: string; user_agent: string; details: string }>(sql`select action, user_agent, details from audit_log`)).rows
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: "signin.rejected", user_agent: "KeepwellTests/1" })
    expect(JSON.parse(audit[0]!.details)).toMatchObject({ apple_sub: "999999.stranger", reason: "not_allowed" })
  })

  it("audits account creation and every session", async () => {
    const { app: http } = testAuthApp(app.db)
    await signIn(http, "000001.author")
    await signIn(http, "000001.author")
    const actions = (await admin.db.execute<{ action: string }>(sql`select action from audit_log order by at`)).rows.map((r) => r.action)
    expect(actions.sort()).toEqual(["account.created", "session.created", "session.created"])
  })

  it("answers /me without a session with 401", async () => {
    const { app: http } = testAuthApp(app.db)
    const res = await http.request("/me")
    expect(res.status).toBe(401)
  })

  it("never lets the app role rewrite or erase the audit log", async () => {
    const { app: http } = testAuthApp(app.db)
    await signIn(http, "000001.author")
    await expect(app.db.execute(sql`update audit_log set action = 'x'`)).rejects.toThrow()
    await expect(app.db.execute(sql`delete from audit_log`)).rejects.toThrow()
  })

  it("only allows the web origin through CORS, with credentials", async () => {
    const { app: http } = testAuthApp(app.db)
    const ok = await http.request("/me", { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" } })
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true")
    const evil = await http.request("/me", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } })
    expect(evil.headers.get("access-control-allow-origin")).not.toBe("https://evil.example")
  })
})

describe("auth mount", () => {
  it("answers the unauthenticated health endpoint the smoke test uses", async () => {
    const db = appDatabase()
    const { app: http } = testAuthApp(db.db)
    const res = await http.request("/api/auth/ok")
    await db.close()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
