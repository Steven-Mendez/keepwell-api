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
