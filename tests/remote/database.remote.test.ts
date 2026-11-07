import { sql } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { APP_ROLE, createDatabase } from "../../src/adapters/database/client"
import { pingDatabase } from "../../src/adapters/database/health"

// Runs in the pipeline against the dev cluster (`pnpm test:remote`), with the deploy role's
// credentials. Never against prod.
const host = process.env.DB_HOST!

describe("dev cluster", () => {
  const app = createDatabase({ kind: "dsql", host, user: APP_ROLE, region: process.env.AWS_REGION })
  afterAll(() => app.close())

  it("accepts the app role through IAM and answers a round trip", async () => {
    await pingDatabase(app.db)
    const [row] = (await app.db.execute<{ current_user: string }>(sql`select current_user`)).rows
    expect(row!.current_user).toBe(APP_ROLE)
  })
})
