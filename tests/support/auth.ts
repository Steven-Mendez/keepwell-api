import { generateKeyPairSync, randomUUID } from "node:crypto"

import { importPKCS8, jwtVerify, SignJWT, importSPKI } from "jose"

import { createAuth } from "../../src/adapters/auth/auth"
import type { AppConfig } from "../../src/adapters/config/config"
import { DrizzleAuditLog } from "../../src/adapters/database/audit-log"
import type { Database } from "../../src/adapters/database/client"
import { DrizzleAccountStore } from "../../src/adapters/database/account-store"
import { InlineJobQueue } from "../../src/adapters/queue/sqs-job-queue"
import { DeleteAccountData } from "../../src/core/use-cases/delete-account-data"
import { RequestAccountDeletion } from "../../src/core/use-cases/request-account-deletion"
import { createApp } from "../../src/entrypoints/http/app"
import { createSyncRepository } from "../../src/adapters/database/sync-store"
import { ScopedLedgerReader } from "../../src/adapters/database/repositories/ledger-reader"
import { scopedDb } from "../../src/adapters/database/scoped-db"
import { ApplySyncBatch } from "../../src/core/use-cases/apply-sync-batch"
import { ReadLedger } from "../../src/core/use-cases/read-ledger"
import { McpConnections } from "../../src/adapters/auth/mcp-connections"
import { ChangeLogWriteCounter } from "../../src/adapters/database/repositories/mcp-write-counter"
import { CreatePending } from "../../src/core/use-cases/create-pending"
import { DrizzleEntitlementRepository } from "../../src/adapters/database/entitlements"
import { CachedPlansSource } from "../../src/adapters/config/plans-source"
import { CLOSED_PLANS, type PlansConfig } from "../../src/core/capabilities"
import { NORMAL_SWITCHES, type Switches } from "../../src/core/switches"
import { ResolveCapabilities } from "../../src/core/use-cases/resolve-capabilities"
import { captureLogger } from "./logger"

// A stand-in for Apple: ID tokens signed with a local RSA key. Everything after the signature check
// (allowlist, account creation, session cookie, audit) is the production code path.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString()

export const TEST_CONFIG: AppConfig = {
  auth_secret: "test-secret-test-secret-test-secret-123",
  apple_team_id: "TEAM000000",
  apple_key_id: "KEY0000000",
  apple_services_id: "app.keepwell.web",
  apple_bundle_id: "app.keepwell.ios",
  apple_private_key: "-----BEGIN PRIVATE KEY-----",
  allowed_apple_subs: ["000001.author", "000002.second"],
}

export async function appleIdToken(sub: string, options: { audience?: string; email?: string } = {}) {
  return new SignJWT({ email: options.email ?? `${sub}@privaterelay.appleid.com`, email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://appleid.apple.com")
    .setAudience(options.audience ?? TEST_CONFIG.apple_bundle_id)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(await importPKCS8(privatePem, "RS256"))
}

async function verify(token: string) {
  try {
    await jwtVerify(token, await importSPKI(publicPem, "RS256"), {
      issuer: "https://appleid.apple.com",
      audience: [TEST_CONFIG.apple_services_id, TEST_CONFIG.apple_bundle_id],
    })
    return true
  } catch {
    return false
  }
}

/** Plans as at launch: sync for everyone during early access, MCP with the coffee. */
export const LAUNCH_PLANS: PlansConfig = { ...CLOSED_PLANS, early_access: { cloud_sync: true } }

export function testAuthApp(db: Database, config: Partial<AppConfig> = {}, options: { runJobs?: boolean; plans?: () => PlansConfig; clock?: () => number; now?: () => Date; baseURL?: string; switches?: () => Switches } = {}) {
  const baseURL = options.baseURL ?? "http://localhost:3001"
  const { logger, lines } = captureLogger()
  const audit = new DrizzleAuditLog(db)
  const accounts = new DrizzleAccountStore(db, logger)
  const queue = new InlineJobQueue(options.runJobs === false ? undefined : (job) => new DeleteAccountData(accounts, audit).execute(job.userId))
  const auth = createAuth({
    db,
    config: { ...TEST_CONFIG, ...config },
    audit: new DrizzleAuditLog(db),
    baseURL,
    webOrigin: "http://localhost:3000",
    appleClientSecret: "unused-in-tests",
    verifyAppleIdToken: verify,
  })
  const requestDeletion = Promise.resolve(new RequestAccountDeletion(accounts, queue, audit))
  const plans = options.plans ?? (() => LAUNCH_PLANS)
  const entitlements = new DrizzleEntitlementRepository(db)
  const capabilities = Promise.resolve(new ResolveCapabilities(entitlements, new CachedPlansSource(async () => JSON.stringify(plans()), logger, 0)))
  const sync = createSyncRepository(db, logger)
  const now = options.now ?? (() => new Date())
  const writer = new ApplySyncBatch(sync)
  const readLedger = new ReadLedger(new ScopedLedgerReader((userId) => scopedDb(db, userId)), writer, now)
  const createPending = new CreatePending({ ledger: readLedger, writer, counter: new ChangeLogWriteCounter((userId) => scopedDb(db, userId)), clock: now })
  const mcp = { readLedger, baseURL, now, connections: new McpConnections(db, audit), createPending }
  const app = createApp({ logger, version: "test", auth: Promise.resolve(auth), webOrigin: "http://localhost:3000", requestDeletion, capabilities, sync, clock: options.clock, mcp, switches: { current: async () => options.switches?.() ?? NORMAL_SWITCHES } })
  return { app, auth, lines, queue, accounts, audit, entitlements, capabilities }
}

/** Signs in through the native-app path and returns the session cookie. */
export async function signIn(app: ReturnType<typeof testAuthApp>["app"], sub: string) {
  const res = await app.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", "user-agent": "KeepwellTests/1" },
    body: JSON.stringify({ provider: "apple", idToken: { token: await appleIdToken(sub) } }),
  })
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ")
  return { res, cookie }
}

export const uniqueSub = () => `0000${randomUUID()}`
