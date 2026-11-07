/** The account itself, as deletion needs it. */
export interface AccountStore {
  /**
   * Marks the account for deletion and ends every session at once, in one transaction. Idempotent:
   * a second call returns the original request time. `undefined` when the user doesn't exist.
   */
  markForDeletion(userId: string, at: Date): Promise<Date | undefined>
  /**
   * Erases up to `batchSize` rows owned by the user from the next table that still has any, and
   * reports what it did. `done` once only the user row is left, which it then removes.
   */
  eraseNextBatch(userId: string, batchSize: number): Promise<{ table: string; deleted: number; done: boolean }>
  isMarkedForDeletion(userId: string): Promise<boolean>
}
