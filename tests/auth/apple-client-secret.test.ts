import { afterAll, describe, expect, it } from "vitest"

import { createAuth } from "../../src/adapters/auth/auth"
import { DrizzleAuditLog } from "../../src/adapters/database/audit-log"
import { AppleSecretKeeper } from "../../src/adapters/external/apple/client-secret"
import { appDatabase } from "../support/database"
import { TEST_CONFIG } from "../support/auth"

const HOUR = 3600_000

function keeper(options: { failAfter?: number } = {}) {
  let time = 0
  let minted = 0
  const errors: unknown[] = []
  const secret = new AppleSecretKeeper(
    async () => {
      minted++
      await Promise.resolve()
      if (options.failAfter !== undefined && minted > options.failAfter) throw new Error("mint failed")
      return `secret-${minted}`
    },
    12 * HOUR,
    () => time,
    (e) => errors.push(e)
  )
  return { secret, errors, advance: (ms: number) => (time += ms), minted: () => minted }
}

describe("Apple client secret refresh", () => {
  const app = appDatabase()
  afterAll(() => app.close())

  it("mints once, reuses it for 12 h, then re-mints", async () => {
    const k = keeper()
    await k.secret.ensureFresh()
    expect(k.secret.current).toBe("secret-1")
    k.advance(11 * HOUR)
    await k.secret.ensureFresh()
    expect(k.secret.current).toBe("secret-1")
    k.advance(2 * HOUR)
    await k.secret.ensureFresh()
    expect(k.secret.current).toBe("secret-2")
    expect(k.minted()).toBe(2)
  })

  it("shares one mint between concurrent callers", async () => {
    const k = keeper()
    await Promise.all([k.secret.ensureFresh(), k.secret.ensureFresh(), k.secret.ensureFresh()])
    expect(k.minted()).toBe(1)
    k.advance(13 * HOUR)
    await Promise.all([k.secret.ensureFresh(), k.secret.ensureFresh()])
    expect(k.minted()).toBe(2)
  })

  it("keeps the previous secret when a refresh fails and retries on the next call", async () => {
    const k = keeper({ failAfter: 1 })
    await k.secret.ensureFresh()
    k.advance(13 * HOUR)
    await k.secret.ensureFresh()
    expect(k.secret.current).toBe("secret-1")
    expect(k.errors).toHaveLength(1)
    await k.secret.ensureFresh()
    expect(k.minted()).toBe(3)
  })

  it("fails the first mint, so the failure shows in /health", async () => {
    const k = keeper({ failAfter: 0 })
    await expect(k.secret.ensureFresh()).rejects.toThrow("mint failed")
  })

  it("Better Auth sees the refreshed secret (it reads the option on each call)", async () => {
    const k = keeper()
    await k.secret.ensureFresh()
    const auth = createAuth({
      db: app.db,
      config: TEST_CONFIG,
      audit: new DrizzleAuditLog(app.db),
      baseURL: "http://localhost:3001",
      webOrigin: "http://localhost:3000",
      appleClientSecret: () => k.secret.current,
    })
    const apple = () => (auth.$context as Promise<{ socialProviders: Array<{ id: string; options: { clientSecret: string } }> }>).then((c) => c.socialProviders.find((p) => p.id === "apple")!.options.clientSecret)
    expect(await apple()).toBe("secret-1")
    k.advance(13 * HOUR)
    await k.secret.ensureFresh()
    expect(await apple()).toBe("secret-2")
  })
})
