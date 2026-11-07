/** Work that doesn't fit in a request (ADR 0006). Today only account deletion. */
export type Job = { type: "delete-account"; userId: string }

export interface JobQueue {
  enqueue(job: Job): Promise<void>
}
