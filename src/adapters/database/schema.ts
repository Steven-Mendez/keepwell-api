import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core"

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
