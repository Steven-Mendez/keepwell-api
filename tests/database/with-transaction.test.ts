import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withTransaction } from "../../src/adapters/database/with-transaction"
import { adminDatabase, appDatabase } from "../support/database"
import { captureLogger } from "../support/logger"

// Two writers on one row, the way two pushes of the same user meet on `sync_state`. Repeatable read
// makes the second commit fail (40001 here, OC000 on DSQL); withTransaction re-runs it whole.
describe("withTransaction", () => {
  const admin = adminDatabase()
  const app = appDatabase()

  beforeAll(async () => {
    await admin.db.execute(sql`create table if not exists occ_probe (id int primary key, n int not null)`)
    await admin.db.execute(sql`grant select, insert, update on occ_probe to keepwell_app`)
  })
  afterAll(async () => {
    await admin.db.execute(sql`drop table if exists occ_probe`)
    await Promise.all([admin.close(), app.close()])
  })

  it("retries the loser of a write conflict until both increments land", async () => {
    await admin.db.execute(sql`delete from occ_probe`)
    await admin.db.execute(sql`insert into occ_probe values (1, 0)`)
    const { logger, lines } = captureLogger()
    let runs = 0
    let release!: () => void
    const bothRead = new Promise<void>((resolve) => (release = resolve))
    let reads = 0

    const increment = () =>
      withTransaction(app.db, logger, async (tx) => {
        runs++
        const [row] = (await tx.execute<{ n: number }>(sql`select n from occ_probe where id = 1`)).rows
        // Hold both first attempts until each has its snapshot, so they really overlap.
        if (++reads <= 2) {
          if (reads === 2) release()
          await bothRead
        }
        await tx.execute(sql`update occ_probe set n = ${row!.n + 1} where id = 1`)
      })

    await Promise.all([increment(), increment()])

    const [row] = (await admin.db.execute<{ n: number }>(sql`select n from occ_probe where id = 1`)).rows
    expect(row!.n).toBe(2)
    expect(runs).toBeGreaterThanOrEqual(3)
    expect(lines.some((line) => line.msg === "transaction conflict, retrying" && line.code === "40001")).toBe(true)
  })

  it("rolls back everything when the closure throws", async () => {
    await admin.db.execute(sql`delete from occ_probe`)
    const { logger } = captureLogger()
    await expect(
      withTransaction(app.db, logger, async (tx) => {
        await tx.execute(sql`insert into occ_probe values (2, 1)`)
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    const rows = await admin.db.execute(sql`select * from occ_probe`)
    expect(rows.rows).toEqual([])
  })
})
