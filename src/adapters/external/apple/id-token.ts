import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose"

const APPLE_ISSUER = "https://appleid.apple.com"
const APPLE_KEYS_URL = new URL("https://appleid.apple.com/auth/keys")

type KeySet = JWTVerifyGetKey & { reload: () => Promise<void> }

/**
 * Apple's signing keys, cached for the life of the Lambda instance. Better Auth's own Apple check
 * downloads the key set on every sign-in (one extra round trip, ~100–300 ms); jose's remote set
 * keeps it in memory for 10 minutes and refetches when a token names a key it doesn't have (key
 * rotation), at most once every 30 seconds, so unknown key ids can't turn into a request flood.
 */
export function createAppleKeySet(fetchKeys?: typeof fetch): KeySet {
  return createRemoteJWKSet(APPLE_KEYS_URL, {
    timeoutDuration: 5_000,
    ...(fetchKeys ? { [customFetch]: (url, options) => fetchKeys(url, options) } : {}),
  }) as KeySet
}

let shared: KeySet | undefined
function sharedKeySet(): KeySet {
  return (shared ??= createAppleKeySet())
}

/** Downloads Apple's keys ahead of the first sign-in. Never throws: the first sign-in fetches them instead. */
export async function warmAppleKeys(keys: Pick<KeySet, "reload"> = sharedKeySet()): Promise<void> {
  try {
    await keys.reload()
  } catch {
    // Offline or Apple unreachable: verification fetches lazily and fails closed if it still can't.
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Same checks as Better Auth's Apple provider (RS256 only, issuer, audience, 1 h maximum age, the
 * required claims, 30 s clock tolerance, nonce plain or SHA-256), with the key set cached. Fails
 * closed: any error is `false`.
 */
export function appleIdTokenVerifier(options: { audience: string[]; keys?: JWTVerifyGetKey }) {
  return async (token: string, nonce?: string): Promise<boolean> => {
    try {
      if (!options.audience.some(Boolean)) return false
      const { payload } = await jwtVerify(token, options.keys ?? sharedKeySet(), {
        issuer: APPLE_ISSUER,
        audience: options.audience,
        algorithms: ["RS256"],
        maxTokenAge: "1h",
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
        clockTolerance: 30,
      })
      if (nonce) {
        const claim = payload.nonce
        if (typeof claim !== "string" || (claim !== nonce && claim !== (await sha256Hex(nonce)))) return false
      }
      return true
    } catch {
      return false
    }
  }
}
