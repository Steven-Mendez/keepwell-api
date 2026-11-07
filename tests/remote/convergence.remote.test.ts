import fc from "fast-check"
import { afterAll, describe, it } from "vitest"

import { APP_ROLE, createDatabase } from "../../src/adapters/database/client"
import { convergenceProperty } from "../support/convergence"
import { signIn, testAuthApp, uniqueSub } from "../support/auth"

// The same property against Aurora DSQL in dev: real optimistic concurrency, real IAM roles. Each
// case signs in a brand-new account, so nothing depends on an empty cluster.
describe("dev cluster: sync convergence", () => {
  const app = createDatabase({ kind: "dsql", host: process.env.DB_HOST!, user: APP_ROLE, region: process.env.AWS_REGION })
  afterAll(() => app.close())

  it("converges on DSQL", async () => {
    await fc.assert(
      convergenceProperty(async () => {
        const sub = uniqueSub()
        const { app: http } = testAuthApp(app.db, { allowed_apple_subs: [sub] })
        const { cookie } = await signIn(http, sub)
        return { http, cookie }
      }),
      { numRuns: 10 }
    )
  }, 600_000)
})
