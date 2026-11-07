import { randomUUID } from "node:crypto"

import type { AuditEvent, AuditLog } from "../../core/ports/audit-log"
import { currentRequest } from "../observability/request-context"
import type { Database } from "./client"
import { auditLog } from "./schema"

/** Writes outside any business transaction: the event is recorded even when the action fails. */
export class DrizzleAuditLog implements AuditLog {
  constructor(private readonly db: Database) {}

  async record(event: AuditEvent): Promise<void> {
    const request = currentRequest()
    await this.db.insert(auditLog).values({
      id: randomUUID(),
      userId: event.userId ?? null,
      actor: event.actor ?? (event.userId ? "user" : "system"),
      action: event.action,
      target: event.target ?? null,
      tokenId: event.tokenId ?? null,
      ip: request?.ip ?? null,
      userAgent: request?.userAgent?.slice(0, 512) ?? null,
      requestId: request?.requestId ?? null,
      details: event.details ? JSON.stringify(event.details) : null,
    })
  }
}
