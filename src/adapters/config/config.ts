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
  /** Sign in with Apple: team, key and Services ID (web) from the developer portal, and the app's bundle ID. */
  apple_team_id: z.string().regex(/^[A-Z0-9]{10}$/, "apple_team_id is a 10-character team ID"),
  apple_key_id: z.string().regex(/^[A-Z0-9]{10}$/, "apple_key_id is a 10-character key ID"),
  apple_services_id: z.string().min(3),
  /**
   * The iOS app's bundle ID; comma-separated when several builds sign in against this API (the
   * App Store build first, then Debug's `.debug`). The first is the one App Store purchases carry.
   */
  apple_bundle_id: z.string().min(3),
  /** The .p8 key, PEM, newlines as \n. */
  apple_private_key: z.string().includes("PRIVATE KEY", { message: "apple_private_key must be the .p8 PEM" }),
  /**
   * Closed registration: Apple user identifiers (`sub`) allowed to sign in, comma-separated. A
   * rejected attempt is recorded in audit_log with its `sub`, which is how the author finds theirs.
   */
  allowed_apple_subs: z
    .string()
    .transform((list) => list.split(",").map((sub) => sub.trim()).filter(Boolean)),
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

/** Every bundle ID in `apple_bundle_id`, the App Store build's first. */
export function appleBundleIds(config: Pick<AppConfig, "apple_bundle_id">): [string, ...string[]] {
  const ids = config.apple_bundle_id.split(",").map((id) => id.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error("apple_bundle_id is empty")
  return ids as [string, ...string[]]
}
