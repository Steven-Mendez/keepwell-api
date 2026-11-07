import type { LedgerRows } from "../ledger/wire-to-domain"

/** Every row of one user's ledger, deleted ones included (the conversion drops them). */
export interface LedgerReader {
  load(userId: string): Promise<LedgerRows>
}
