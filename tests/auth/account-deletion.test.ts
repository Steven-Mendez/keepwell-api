import { sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { KEPT_AFTER_DELETION, USER_OWNED_TABLES } from "../../src/adapters/database/account-store"
import { DeleteAccountData } from "../../src/core/use-cases/delete-account-data"
import { handleJob } from "../../src/entrypoints/jobs/handle-job"
import { adminDatabase, appDatabase } from "../support/database"
import { captureLogger } from "../support/logger"
import { signIn, testAuthApp } from "../support/auth"

describe("account deletion", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))
  beforeEach(async () => {
    for (const table of ["sessions", "accounts", "users", "audit_log"]) await admin.db.execute(sql.raw(`delete from ${table}`))
  })

  const userIdOf = async (sub: string) =>
    (await admin.db.execute<{ user_id: string }>(sql`select user_id from accounts where account_id = ${sub}`)).rows[0]!.user_id

  it("ends access at once, then the job leaves no row with the user's id outside the audit log", async () => {
    const { app: http, queue } = testAuthApp(app.db, {}, { runJobs: false })
    const { cookie } = await signIn(http, "000001.author")
    const second = await signIn(http, "000001.author")
    const userId = await userIdOf("000001.author")

    const res = await http.request("/me", { method: "DELETE", headers: { cookie, origin: "http://localhost:3000" } })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ status: "deletion_requested", backups_retained_days: 35 })
    // Both sessions are gone before the job runs.
    expect((await http.request("/me", { headers: { cookie } })).status).toBe(401)
    expect((await http.request("/me", { headers: { cookie: second.cookie } })).status).toBe(401)
    expect(queue.jobs).toEqual([{ type: "delete-account", userId }])

    const { accounts, audit } = testAuthApp(app.db)
    const result = await new DeleteAccountData(accounts, audit).execute(userId)
    expect(result.status).toBe("deleted")

    for (const table of ["users", "sessions", "accounts"]) {
      const column = table === "users" ? "id" : "user_id"
      const rows = await admin.db.execute(sql.raw(`select 1 from ${table} where ${column} = '${userId}'`))
      expect(rows.rows, table).toEqual([])
    }
    const actions = (await admin.db.execute<{ action: string }>(sql`select action from audit_log where target = ${userId}`)).rows
    expect(actions.map((r) => r.action)).toEqual(["account.deleted"])
  })

  it("can't be signed back into while it waits for the job", async () => {
    const { app: http } = testAuthApp(app.db, {}, { runJobs: false })
    const { cookie } = await signIn(http, "000001.author")
    await http.request("/me", { method: "DELETE", headers: { cookie, origin: "http://localhost:3000" } })
    const again = await signIn(http, "000001.author")
    expect(again.res.status).toBe(403)
    expect(again.cookie).not.toContain("session_token")
  })

  it("is idempotent: a redelivered job finishes or does nothing, and a second request is harmless", async () => {
    const { app: http, accounts, audit } = testAuthApp(app.db, {}, { runJobs: false })
    const { cookie } = await signIn(http, "000001.author")
    const userId = await userIdOf("000001.author")
    await http.request("/me", { method: "DELETE", headers: { cookie, origin: "http://localhost:3000" } })
    const job = new DeleteAccountData(accounts, audit)
    await job.execute(userId)
    expect(await job.execute(userId)).toEqual({ deletedRows: 0, status: "deleted" })
  })

  it("refuses to erase an account nobody asked to delete", async () => {
    const { app: http, accounts, audit } = testAuthApp(app.db, {}, { runJobs: false })
    await signIn(http, "000001.author")
    const userId = await userIdOf("000001.author")
    expect(await new DeleteAccountData(accounts, audit).execute(userId)).toEqual({ deletedRows: 0, status: "not_marked" })
    expect((await admin.db.execute(sql`select 1 from users where id = ${userId}`)).rows).toHaveLength(1)
  })

  it("drops a malformed queue message instead of retrying it forever", async () => {
    const { accounts, audit } = testAuthApp(app.db)
    const { logger, lines } = captureLogger()
    await handleJob(JSON.stringify({ type: "nope" }), { deleteAccount: new DeleteAccountData(accounts, audit), log: logger })
    expect(lines.some((l) => l.msg === "unknown job dropped")).toBe(true)
  })

  it("knows every table with a user_id column, so a new one can't be forgotten", async () => {
    const tables = (
      await admin.db.execute<{ table_name: string }>(
        sql`select distinct table_name from information_schema.columns where table_schema = 'public' and column_name = 'user_id'`
      )
    ).rows.map((r) => r.table_name)
    const covered = new Set([...USER_OWNED_TABLES.map((t) => t.name), ...KEPT_AFTER_DELETION])
    expect(tables.filter((t) => !covered.has(t))).toEqual([])
  })
})
