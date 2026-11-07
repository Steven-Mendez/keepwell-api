import { validateSyncEvent, type RecordSource, type SyncEntity, type SyncEvent, type SyncRow } from "../domain/schema"
import type { EventResult, SyncRepository } from "../ports/sync-repository"
import { decide, type StoredRow } from "../sync/conflict"

export const MAX_PUSH_EVENTS = 200
/** Events per transaction: far under DSQL's 3,000 rows (each event writes three). */
export const PUSH_CHUNK = 50

export interface PushResult {
  event_id: string
  status: EventResult
  reason?: string
  server_seq?: number
  /** Applied: the stored `updated_at`, which differs from the sent one when the server capped it. */
  updated_at?: string
  /**
   * Stale: the row the server keeps. The device adopts it, since it will never pull its own event
   * and would otherwise keep a version that lost.
   */
  current?: StoredRow
}

export interface PushOutcome {
  results: PushResult[]
  /** True when time ran out; the events not listed must be sent again. */
  partial: boolean
  metrics: { applied: number; stale: number; rejected: number; replayed: number }
}

/**
 * POST /sync/push (ADR 0005). Each event is validated on its own: an invalid one is `rejected` with
 * the reason and never blocks the rest. Valid events are applied in chunks, each chunk one
 * transaction that first bumps the user's sequence, so a user's writes are serialized and pulls
 * never skip a change. A resent event gets its recorded answer. When the deadline is near, the
 * outcome lists what committed and the client resends the rest.
 */
export class ApplySyncBatch {
  constructor(
    private readonly repository: SyncRepository,
    private readonly clock: () => number = () => Date.now()
  ) {}

  /** `createdBy` is `mcp` only for rows the MCP tools write; sync always creates `app` rows. */
  async execute(input: { userId: string; clientId: string; platform: string; events: unknown[]; deadline: number; createdBy?: RecordSource }): Promise<PushOutcome> {
    const { userId, clientId } = input
    const outcome: PushOutcome = { results: [], partial: false, metrics: { applied: 0, stale: 0, rejected: 0, replayed: 0 } }
    await this.repository.touchClient(userId, clientId, input.platform)

    const checked = input.events.slice(0, MAX_PUSH_EVENTS).map((raw) => ({ raw, check: validateSyncEvent(raw) }))
    for (let start = 0; start < checked.length; start += PUSH_CHUNK) {
      if (this.clock() >= input.deadline) {
        outcome.partial = true
        break
      }
      const chunk = checked.slice(start, start + PUSH_CHUNK)
      const results = await this.repository.transaction(userId, async (unit) => {
        const out: PushResult[] = []
        const ids = chunk.flatMap(({ raw }) => (eventIdOf(raw) ? [eventIdOf(raw)!] : []))
        const previous = await unit.previousResults(ids)
        const fresh = chunk.filter(({ raw, check }) => check.ok && !previous.has(eventIdOf(raw)!))
        let seq = fresh.length > 0 ? await unit.reserveSequence(fresh.length) : 0
        const now = unit.now()
        for (const { raw, check } of chunk) {
          const eventId = eventIdOf(raw) ?? "unknown"
          const recorded = previous.get(eventId)
          if (recorded) {
            // A resend means the first answer may have been lost: send the row as it stands now.
            const current = check.ok ? await unit.currentRow(check.event.entity, check.event.entity_id) : undefined
            out.push({ ...toResult(eventId, recorded.result, recorded.reason, recorded.serverSeq, true), ...(current ? { current } : {}) })
            continue
          }
          if (!check.ok) {
            // Not recorded: a fixed client resends the same id and it is judged again.
            out.push({ event_id: eventId, status: "rejected", reason: check.reason })
            continue
          }
          const event: SyncEvent = check.event
          const entity: SyncEntity = event.entity
          const existing = await unit.currentRow(entity, event.entity_id)
          const decision = decide(entity, existing, check.row as SyncRow, now, input.createdBy ?? "app")
          const serverSeq = seq++
          if (decision.result === "applied") {
            await unit.writeRow(entity, decision.row, existing !== undefined)
            await unit.appendChange({ serverSeq, entity, entityId: event.entity_id, operation: decision.operation, row: decision.row, clientId, eventId, status: "applied" })
            await unit.recordResult(eventId, { result: "applied", reason: null, serverSeq })
            out.push({ event_id: eventId, status: "applied", server_seq: serverSeq, updated_at: decision.row.updated_at })
          } else {
            await unit.appendChange({ serverSeq, entity, entityId: event.entity_id, operation: event.operation, row: check.row, clientId, eventId, status: "stale" })
            await unit.recordResult(eventId, { result: "stale", reason: decision.why, serverSeq })
            out.push({ event_id: eventId, status: "stale", reason: decision.why, server_seq: serverSeq, ...(existing ? { current: existing } : {}) })
          }
        }
        return out
      })
      outcome.results.push(...results)
    }
    for (const result of outcome.results) {
      if ((result as PushResult & { replayed?: boolean }).replayed) outcome.metrics.replayed++
      outcome.metrics[result.status]++
      delete (result as PushResult & { replayed?: boolean }).replayed
    }
    return outcome
  }
}

function eventIdOf(raw: unknown): string | undefined {
  const id = (raw as { event_id?: unknown } | null)?.event_id
  return typeof id === "string" ? id.toLowerCase() : undefined
}

function toResult(eventId: string, status: EventResult, reason: string | null, serverSeq: number | null, replayed: boolean) {
  return { event_id: eventId, status, ...(reason ? { reason } : {}), ...(serverSeq !== null ? { server_seq: serverSeq } : {}), replayed }
}
