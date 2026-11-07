import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// Drizzle tables. Money and rates are `text` holding exact decimals (DECIMAL_PATTERN), never
// `numeric`: DSQL's bare `numeric` is numeric(18,6) and rounds silently. JSON is stored as `text`.
// No foreign keys, by decision (ADR 0003): integrity lives in the code, as it does in Dexie and
// SwiftData, and cascades would count against DSQL's per-transaction row limit.

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull()

// --- Better Auth (generated with `npx auth generate --adapter drizzle`, foreign keys removed) ---

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  /**
   * Set when the person asks to delete the account. From then on no session can be created and the
   * deletion job erases their data in batches; the row itself goes last.
   */
  deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
  /**
   * "Disconnect everything": MCP access tokens issued before this instant are refused. Access tokens
   * are JWTs that can't be revoked one by one, so this is how revocation is immediate (ADR 0007).
   */
  mcpTokensNotBefore: timestamp("mcp_tokens_not_before", { withTimezone: true }),
})

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)]
)

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("accounts_user_id_idx").on(table.userId)]
)

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)]
)

// --- Passkeys (Better Auth passkey plugin), relying party: the web app's host ---

export const passkeys = pgTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id").notNull(),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    aaguid: text("aaguid"),
  },
  (table) => [index("passkeys_user_id_idx").on(table.userId), index("passkeys_credential_id_idx").on(table.credentialID)]
)

// --- OAuth 2.1 for MCP (Better Auth jwt, mcp/oauth-provider and cimd plugins) ---
// Generated with `npx auth generate --adapter drizzle`, then adapted for DSQL: arrays and JSON are
// text (the adapter is patched to serialize them, patches/@better-auth__drizzle-adapter*.patch),
// and foreign keys are dropped.

const at = (name: string) => timestamp(name, { withTimezone: true })

export const jwkss = pgTable("jwkss", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: at("created_at").notNull(),
  expiresAt: at("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
})

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes"),
    clientCredentialsScopes: text("client_credentials_scopes"),
    userId: text("user_id"),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types"),
    responseTypes: text("response_types"),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: text("metadata"),
  },
  (table) => [index("oauth_clients_user_id_idx").on(table.userId)]
)

export const oauthResources = pgTable("oauth_resources", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes"),
  customClaims: text("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: at("created_at"),
  updatedAt: at("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: text("metadata"),
})

export const oauthClientResources = pgTable(
  "oauth_client_resources",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: text("metadata"),
    createdAt: at("created_at"),
  },
  (table) => [
    uniqueIndex("oauth_client_resources_client_resource_uidx").on(table.clientId, table.resourceId),
    index("oauth_client_resources_resource_id_idx").on(table.resourceId),
  ]
)

/** A function, not a shared object: Drizzle column builders carry their table's constraint names. */
const tokenColumns = () => ({
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("client_id").notNull(),
  sessionId: text("session_id"),
  referenceId: text("reference_id"),
  authorizationCodeId: text("authorization_code_id"),
  resources: text("resources"),
  requestedUserInfoClaims: text("requested_user_info_claims"),
  expiresAt: at("expires_at").notNull(),
  createdAt: at("created_at").notNull(),
  revoked: at("revoked"),
  confirmation: text("confirmation"),
  scopes: text("scopes").notNull(),
})

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    ...tokenColumns(),
    userId: text("user_id").notNull(),
    rotatedAt: at("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: at("rotation_replay_expires_at"),
    authTime: at("auth_time"),
  },
  (table) => [index("oauth_refresh_tokens_user_id_idx").on(table.userId), index("oauth_refresh_tokens_client_id_idx").on(table.clientId)]
)

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  { ...tokenColumns(), userId: text("user_id"), refreshId: text("refresh_id") },
  (table) => [index("oauth_access_tokens_user_id_idx").on(table.userId), index("oauth_access_tokens_refresh_id_idx").on(table.refreshId)]
)

export const oauthConsents = pgTable(
  "oauth_consents",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id"),
    referenceId: text("reference_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    scopes: text("scopes").notNull(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [index("oauth_consents_user_id_idx").on(table.userId), index("oauth_consents_client_id_idx").on(table.clientId)]
)

export const oauthClientAssertions = pgTable("oauth_client_assertions", {
  id: text("id").primaryKey(),
  expiresAt: at("expires_at").notNull(),
})

// --- Security and account events: insert-only for keepwell_app (granted in the migration) ---

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    /** Null when the event has no account yet, such as a rejected sign-up. */
    userId: text("user_id"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    /** `user`, `system` or `mcp_client:<client id>`. */
    actor: text("actor").notNull(),
    /** Dotted verb: `session.created`, `signup.rejected`, `account.deleted`... */
    action: text("action").notNull(),
    target: text("target"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    tokenId: text("token_id"),
    requestId: text("request_id"),
    /** JSON text. Never amounts, descriptions, notes, emails or tokens. */
    details: text("details"),
  },
  (table) => [index("audit_log_user_at_idx").on(table.userId, table.at)]
)

export * from "./sync-tables"
