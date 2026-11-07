import { Writable } from "node:stream"

import { createLogger } from "../../src/adapters/observability/logger"

/** A logger whose lines land in `lines` (parsed), so tests can assert on what was logged. */
export function captureLogger() {
  const lines: Record<string, unknown>[] = []
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(line))
      callback()
    },
  })
  return { logger: createLogger({ version: "test", level: "debug", destination }), lines }
}
