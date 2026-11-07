import fc from "fast-check"
import { afterAll, describe, it } from "vitest"

import { convergenceProperty } from "../support/convergence"
import { adminDatabase, appDatabase } from "../support/database"
import { signIn, testAuthApp } from "../support/auth"
import { wipe } from "../support/sync"

describe("sync convergence (property-based)", () => {
  const app = appDatabase()
  const admin = adminDatabase()
  afterAll(() => Promise.all([app.close(), admin.close()]))

  it(
    "converges every device to the server, losing no payment and reviving nothing",
    async () => {
      await fc.assert(
        convergenceProperty(async () => {
          await wipe(admin.db)
          const { app: http } = testAuthApp(app.db)
          const { cookie } = await signIn(http, "000001.author")
          return { http, cookie }
        }),
        { numRuns: Number(process.env.FC_RUNS ?? 30), seed: Number(process.env.FC_SEED ?? Date.now() % 1_000_000), verbose: 1 }
      )
    },
    180_000
  )
})
