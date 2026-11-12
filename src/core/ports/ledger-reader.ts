import type { LedgerRows } from "../ledger/wire-to-domain"

/** Every row of one user's ledger, deleted ones included (the conversion drops them). */
export interface LedgerReader {
  load(userId: string): Promise<LedgerRows>
  /** The zone the person's most recently seen push device reported, if any registered (ADR 0012). */
  latestDeviceTimeZone(userId: string): Promise<string | undefined>
}
