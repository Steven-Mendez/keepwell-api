import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { describe, expect, it, vi } from "vitest"

import { appleIdTokenVerifier, createAppleKeySet, warmAppleKeys } from "../../src/adapters/external/apple/id-token"

const AUD = "app.keepwell.ios"

async function keyPair(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" } }
}

function token(privateKey: CryptoKey, kid: string, extra: Record<string, unknown> = {}) {
  return new SignJWT({ ...extra })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer("https://appleid.apple.com")
    .setAudience(AUD)
    .setSubject("sub1")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey)
}

function keysFetch(getKeys: () => unknown[]) {
  return vi.fn(async () => new Response(JSON.stringify({ keys: getKeys() }), { status: 200, headers: { "content-type": "application/json" } }))
}

describe("Apple ID token verification", () => {
  it("downloads the keys once and reuses them", async () => {
    const a = await keyPair("A")
    const fetchKeys = keysFetch(() => [a.jwk])
    const verify = appleIdTokenVerifier({ audience: [AUD], keys: createAppleKeySet(fetchKeys as unknown as typeof fetch) })
    expect(await verify(await token(a.privateKey, "A"))).toBe(true)
    expect(await verify(await token(a.privateKey, "A"))).toBe(true)
    expect(fetchKeys).toHaveBeenCalledTimes(1)
  })

  it("refetches when a token names an unknown key id (rotation)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const a = await keyPair("A")
      const b = await keyPair("B")
      let published = [a.jwk]
      const fetchKeys = keysFetch(() => published)
      const verify = appleIdTokenVerifier({ audience: [AUD], keys: createAppleKeySet(fetchKeys as unknown as typeof fetch) })
      expect(await verify(await token(a.privateKey, "A"))).toBe(true)
      published = [a.jwk, b.jwk]
      vi.setSystemTime(Date.now() + 31_000) // past jose's 30 s refetch cooldown
      expect(await verify(await token(b.privateKey, "B"))).toBe(true)
      expect(fetchKeys).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects wrong audience, forged signatures and bad nonces", async () => {
    const a = await keyPair("A")
    const other = await keyPair("A")
    const keys = createAppleKeySet(keysFetch(() => [a.jwk]) as unknown as typeof fetch)
    const verify = appleIdTokenVerifier({ audience: ["someone.else"], keys })
    expect(await verify(await token(a.privateKey, "A"))).toBe(false)
    const ok = appleIdTokenVerifier({ audience: [AUD], keys })
    expect(await ok(await token(other.privateKey, "A"))).toBe(false)
    expect(await ok(await token(a.privateKey, "A", { nonce: "n1" }), "n2")).toBe(false)
    expect(await ok(await token(a.privateKey, "A", { nonce: "n1" }), "n1")).toBe(true)
  })

  it("warming never throws", async () => {
    await expect(warmAppleKeys({ reload: async () => Promise.reject(new Error("offline")) })).resolves.toBeUndefined()
  })
})
