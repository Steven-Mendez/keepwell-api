import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { DrizzleAuditLog } from "../../src/adapters/database/audit-log"
import { DrizzleInvitationStore } from "../../src/adapters/database/invitation-store"
import { createInvitation, newInvitationCode, normalizeInvitation } from "../../src/core/use-cases/admit-sign-in"
import { adminDatabase, appDatabase } from "../support/database"
import { appleIdToken, testAuthApp } from "../support/auth"

describe("invitations", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(async () => {
    for (const table of ["sessions", "accounts", "users", "audit_log", "invitations"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  // Created by the operator (pnpm invite), with the admin role.
  const invite = (options: { days?: number; now?: Date } = {}) =>
    createInvitation(new DrizzleInvitationStore(admin.db), new DrizzleAuditLog(admin.db), { days: options.days ?? 7, note: "test", now: options.now })

  const signIn = async (http: ReturnType<typeof testAuthApp>["app"], sub: string, headers: Record<string, string> = {}) =>
    http.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
      body: JSON.stringify({ provider: "apple", idToken: { token: await appleIdToken(sub) } }),
    })
  const audit = async (action: string) => (await admin.db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where action = ${action}`)).rows[0]!.n

  it("lets a new person in with a code, once, and lets them back without it", async () => {
    const { app: http } = testAuthApp(app.db)
    const { code } = await invite()
    expect((await signIn(http, "000100.newcomer")).status).toBe(403)
    expect((await signIn(http, "000100.newcomer", { "x-keepwell-invitation": code.toLowerCase() })).status).toBe(200)
    expect((await signIn(http, "000100.newcomer")).status).toBe(200)
    expect(await audit("invitation.redeemed")).toBe(1)
    // Used: nobody else gets in with it, and the store keeps no readable code.
    const other = await signIn(http, "000101.other", { "x-keepwell-invitation": code })
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ code: "INVALID_INVITATION" })
    const rows = (await admin.db.execute<{ code_hash: string }>(sql`select code_hash from invitations`)).rows
    expect(rows[0]!.code_hash).not.toContain(normalizeInvitation(code))
  })

  it("refuses an expired code and an invented one", async () => {
    const { app: http } = testAuthApp(app.db)
    const { code } = await invite({ days: 1, now: new Date(Date.now() - 2 * 86_400_000) })
    expect((await signIn(http, "000100.newcomer", { "x-keepwell-invitation": code })).status).toBe(403)
    expect((await signIn(http, "000100.newcomer", { "x-keepwell-invitation": newInvitationCode() })).status).toBe(403)
    expect(await audit("signin.rejected")).toBe(2)
  })

  it("carries the code through a cookie for the web's redirect flow, without consuming it early", async () => {
    const { app: http } = testAuthApp(app.db)
    const { code } = await invite()
    const claim = (value: string) =>
      http.request("/invitations/claim", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ code: value }) })
    expect((await claim("NOPE0-NOPE0")).status).toBe(404)
    const claimed = await claim(code)
    expect(claimed.status).toBe(204)
    const cookie = claimed.headers.get("set-cookie")!
    expect(cookie).toMatch(/keepwell_invitation=.*HttpOnly.*/i)
    expect(cookie).toContain("Path=/api/auth")
    expect((await claim(code)).status).toBe(204) // still open: checking does not consume
    expect((await signIn(http, "000100.newcomer", { cookie: cookie.split(";")[0]! })).status).toBe(200)
    expect((await claim(code)).status).toBe(404)
  })

  it("forgets who used an invitation when the account is deleted", async () => {
    const { app: http } = testAuthApp(app.db)
    const { code } = await invite()
    const res = await signIn(http, "000100.newcomer", { "x-keepwell-invitation": code })
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ")
    expect((await http.request("/me", { method: "DELETE", headers: { cookie, origin: "http://localhost:3000" } })).status).toBe(202)
    await expect.poll(async () => (await admin.db.execute(sql`select redeemed_by, redeemed_at is not null as used from invitations`)).rows).toEqual([{ redeemed_by: null, used: true }])
  })
})
