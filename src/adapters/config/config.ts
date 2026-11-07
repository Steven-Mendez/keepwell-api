import { readFile } from "node:fs/promises"

import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm"
import { z } from "zod"

/**
 * Everything the API reads from configuration at start-up. Secrets come from SSM Parameter Store
 * (SecureString) under `/keepwell/<env>/`, never from environment variables or Terraform state. In
 * development the same keys come from `config.local.json` (git-ignored).
 */
export const AppConfig = z.object({
  /** Signs sessions and tokens (Better Auth). 32+ characters; rotated per docs/runbooks. */
  auth_secret: z.string().min(32, "auth_secret must be at least 32 characters (still the placeholder?)"),
})
export type AppConfig = z.infer<typeof AppConfig>

export type ConfigSource = { kind: "ssm"; prefix: string; region?: string } | { kind: "file"; path: string }

export function configSourceFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigSource {
  if (env.CONFIG_PREFIX) return { kind: "ssm", prefix: env.CONFIG_PREFIX, region: env.AWS_REGION }
  return { kind: "file", path: env.CONFIG_FILE ?? "config.local.json" }
}

/** Reads the raw key/value map: parameter names without the prefix, decrypted. */
export async function readRawConfig(source: ConfigSource, ssm?: SSMClient): Promise<Record<string, string>> {
  if (source.kind === "file") return JSON.parse(await readFile(source.path, "utf8")) as Record<string, string>
  const client = ssm ?? new SSMClient({ region: source.region })
  const prefix = source.prefix.replace(/\/$/, "")
  const values: Record<string, string> = {}
  let NextToken: string | undefined
  do {
    const page = await client.send(new GetParametersByPathCommand({ Path: prefix, Recursive: true, WithDecryption: true, NextToken }))
    for (const parameter of page.Parameters ?? []) {
      if (parameter.Name && parameter.Value !== undefined) values[parameter.Name.slice(prefix.length + 1)] = parameter.Value
    }
    NextToken = page.NextToken
  } while (NextToken)
  return values
}

/** Loads and validates. A missing or placeholder secret fails here, loudly, not on first use. */
export async function loadConfig(source: ConfigSource, ssm?: SSMClient): Promise<AppConfig> {
  const raw = await readRawConfig(source, ssm)
  const parsed = AppConfig.safeParse(raw)
  if (!parsed.success) {
    // Names only: values may be secrets.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    throw new Error(`Invalid configuration: ${problems.join("; ")}`)
  }
  return parsed.data
}
