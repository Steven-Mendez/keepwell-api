import type { ReconciliationSource } from "../ports/reconciliation"

export interface Discrepancy {
  userId: string
  /** `entity:id` */
  key: string
  kind: "missing_in_projection" | "missing_in_history" | "different"
  /** Column names that differ; never their values (they may be amounts or descriptions). */
  columns?: string[]
}

/**
 * Rebuilds each user's ledger from the immutable `change_log` and compares it with the tables. The
 * tables are a projection of the log: any difference means a write bypassed the log or the log
 * lost a write, and is an alarm (ADR 0004). Balances are never stored, so matching rows means
 * matching balances.
 */
export class Reconcile {
  constructor(private readonly source: ReconciliationSource) {}

  async execute(only?: string[]): Promise<{ users: number; rows: number; discrepancies: Discrepancy[] }> {
    const users = only ?? (await this.source.users())
    const discrepancies: Discrepancy[] = []
    let rows = 0
    for (const userId of users) {
      const [history, projection] = await Promise.all([this.source.replayHistory(userId), this.source.projection(userId)])
      rows += projection.size
      for (const [key, expected] of history) {
        const actual = projection.get(key)
        if (!actual) {
          discrepancies.push({ userId, key, kind: "missing_in_projection" })
          continue
        }
        const columns = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
          (column) => JSON.stringify(expected[column] ?? null) !== JSON.stringify(actual[column] ?? null)
        )
        if (columns.length > 0) discrepancies.push({ userId, key, kind: "different", columns })
      }
      for (const key of projection.keys()) if (!history.has(key)) discrepancies.push({ userId, key, kind: "missing_in_history" })
    }
    return { users: users.length, rows, discrepancies }
  }
}
