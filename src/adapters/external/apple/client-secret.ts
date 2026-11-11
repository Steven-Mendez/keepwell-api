import { importPKCS8, SignJWT } from "jose"

/**
 * Apple's "client secret" is a JWT signed with the .p8 key from the developer portal (ES256), valid
 * at most six months. It is minted at cold start and lives as long as the Lambda instance, so the
 * key in SSM is the only long-lived credential and rotating it needs no deploy.
 */
export async function appleClientSecret(options: {
  teamId: string
  keyId: string
  servicesId: string
  privateKey: string
  lifetimeSeconds?: number
  now?: Date
}): Promise<string> {
  const key = await importPKCS8(options.privateKey.replace(/\\n/g, "\n"), "ES256")
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: options.keyId })
    .setIssuer(options.teamId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.lifetimeSeconds ?? 24 * 3600))
    .setAudience("https://appleid.apple.com")
    .setSubject(options.servicesId)
    .sign(key)
}

/**
 * Keeps Apple's client secret fresh for a long-lived instance. It is minted with a 24 h lifetime,
 * and a provisioned Lambda instance can outlive that, so it is re-minted once older than
 * `maxAgeMs` (12 h by default). Minting is local (sign with the .p8 key, no network). Concurrent
 * callers share one in-flight mint, and a failed refresh keeps the previous secret, still valid
 * for hours, and is retried by the next call.
 */
export class AppleSecretKeeper {
  private secret?: string
  private mintedAt = 0
  private pending?: Promise<void>

  constructor(
    private readonly mint: () => Promise<string>,
    private readonly maxAgeMs = 12 * 3600_000,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  /** The latest minted secret (synchronous: Better Auth reads it when it calls Apple). */
  get current(): string {
    if (this.secret === undefined) throw new Error("Apple client secret has not been minted yet")
    return this.secret
  }

  /** Mints the first secret (rejects if that fails) or refreshes a stale one (never rejects). */
  async ensureFresh(): Promise<void> {
    if (this.secret !== undefined && this.now() - this.mintedAt < this.maxAgeMs) return
    this.pending ??= this.refresh().finally(() => (this.pending = undefined))
    await this.pending
  }

  private async refresh(): Promise<void> {
    try {
      this.secret = await this.mint()
      this.mintedAt = this.now()
    } catch (error) {
      if (this.secret === undefined) throw error
      this.onError(error)
    }
  }
}
