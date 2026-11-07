/**
 * Security and account events (ADR 0004): sign-ins, rejected sign-ups, tokens, plan grants,
 * deletions. Insert-only. `details` never carries amounts, descriptions, notes, emails or tokens.
 */
export interface AuditEvent {
  action: string
  userId?: string | null
  /** `user`, `system` or `mcp_client:<client id>`. Defaults to `user` when there is a user. */
  actor?: string
  target?: string | null
  tokenId?: string | null
  details?: Record<string, string | number | boolean | null>
}

export interface AuditLog {
  record(event: AuditEvent): Promise<void>
}
