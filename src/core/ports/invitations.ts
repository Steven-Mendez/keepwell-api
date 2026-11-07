export interface InvitationStore {
  /** Whether this Apple identity already has a Keepwell account (returning people need no invitation). */
  hasAppleAccount(appleSub: string): Promise<boolean>
  /**
   * Marks the invitation used by this Apple identity, atomically. True when it was unused and
   * unexpired, or already used by this same identity (a retried sign-in); false otherwise.
   */
  redeem(codeHash: string, appleSub: string, now: Date): Promise<boolean>
  /** True when the code exists, is unexpired and unused. Does not consume it. */
  isOpen(codeHash: string, now: Date): Promise<boolean>
  create(invitation: { id: string; codeHash: string; expiresAt: Date; note: string | null }): Promise<void>
}
