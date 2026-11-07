import { Environment, SignedDataVerifier, type JWSTransactionDecodedPayload } from "@apple/app-store-server-library"

import type { AppStoreVerifier, VerifiedNotification, VerifiedTransaction } from "../../../core/ports/app-store"
import { APPLE_ROOT_CA_G3 } from "./apple-root-ca-g3"

/**
 * Apple's own library checks the JWS signature and the certificate chain up to Apple Root CA G3,
 * the bundle id and the environment. Production is always tried; Sandbox only where purchases from
 * TestFlight and StoreKit sandbox are accepted (dev).
 */
export class AppleAppStoreVerifier implements AppStoreVerifier {
  private readonly verifiers: SignedDataVerifier[]

  constructor(options: { bundleId: string; appAppleId?: number; acceptSandbox: boolean; onlineChecks?: boolean }) {
    const roots = [Buffer.from(APPLE_ROOT_CA_G3, "base64")]
    const online = options.onlineChecks ?? true
    this.verifiers = [new SignedDataVerifier(roots, online, Environment.PRODUCTION, options.bundleId, options.appAppleId)]
    if (options.acceptSandbox) this.verifiers.push(new SignedDataVerifier(roots, online, Environment.SANDBOX, options.bundleId))
  }

  private async first<T>(work: (verifier: SignedDataVerifier) => Promise<T>): Promise<T> {
    let last: unknown
    for (const verifier of this.verifiers) {
      try {
        return await work(verifier)
      } catch (error) {
        last = error
      }
    }
    throw last
  }

  async transaction(signed: string): Promise<VerifiedTransaction> {
    return toTransaction(await this.first((verifier) => verifier.verifyAndDecodeTransaction(signed)))
  }

  async notification(signed: string): Promise<VerifiedNotification> {
    return this.first(async (verifier) => {
      const payload = await verifier.verifyAndDecodeNotification(signed)
      const signedTransaction = payload.data?.signedTransactionInfo
      return {
        notificationUUID: payload.notificationUUID ?? "",
        type: String(payload.notificationType ?? ""),
        subtype: payload.subtype ? String(payload.subtype) : null,
        transaction: signedTransaction ? toTransaction(await verifier.verifyAndDecodeTransaction(signedTransaction)) : null,
      }
    })
  }
}

function toTransaction(payload: JWSTransactionDecodedPayload): VerifiedTransaction {
  if (!payload.originalTransactionId || !payload.productId || !payload.bundleId) throw new Error("Incomplete transaction")
  return {
    originalTransactionId: payload.originalTransactionId,
    transactionId: payload.transactionId ?? payload.originalTransactionId,
    productId: payload.productId,
    bundleId: payload.bundleId,
    environment: String(payload.environment ?? "Production") as VerifiedTransaction["environment"],
    purchasedAt: new Date(payload.purchaseDate ?? payload.originalPurchaseDate ?? Date.now()),
    revokedAt: payload.revocationDate ? new Date(payload.revocationDate) : null,
    expiresAt: payload.expiresDate ? new Date(payload.expiresDate) : null,
  }
}
