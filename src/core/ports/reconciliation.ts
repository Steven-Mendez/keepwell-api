/** One stored row of the ledger, keyed by entity and id, as JSON-comparable data. */
export type LedgerSnapshot = Map<string, Record<string, unknown>>

export interface ReconciliationSource {
  /** Users with any history. */
  users(): Promise<string[]>
  /** The last applied version of every row in `change_log`, replayed in `server_seq` order. */
  replayHistory(userId: string): Promise<LedgerSnapshot>
  /** The tables as they are now. */
  projection(userId: string): Promise<LedgerSnapshot>
}
