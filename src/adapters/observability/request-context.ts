import { AsyncLocalStorage } from "node:async_hooks"

/** Who is asking, available to adapters (the audit log) without threading it through every call. */
export interface RequestInfo {
  requestId: string
  ip: string | null
  userAgent: string | null
}

const storage = new AsyncLocalStorage<RequestInfo>()

export function runWithRequest<T>(info: RequestInfo, work: () => Promise<T>): Promise<T> {
  return storage.run(info, work)
}

export function currentRequest(): RequestInfo | undefined {
  return storage.getStore()
}
