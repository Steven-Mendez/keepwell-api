import pino from "pino"

export type Logger = pino.Logger

/**
 * JSON lines on stdout, which CloudWatch Logs ingests as is. Never log amounts, descriptions, notes,
 * emails or tokens: the redaction list is the last line of defense, not the first.
 */
export function createLogger(options: { version: string; level?: string; destination?: pino.DestinationStream }): Logger {
  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      base: { service: "keepwell-api", version: options.version },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: [
          "authorization",
          "cookie",
          "*.authorization",
          "*.cookie",
          "*.token",
          "*.accessToken",
          "*.refreshToken",
          "*.idToken",
          "*.email",
          "*.amount",
          "*.description",
          "*.note",
        ],
        censor: "[redacted]",
      },
    },
    options.destination
  )
}
