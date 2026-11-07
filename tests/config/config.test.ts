import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GetParametersByPathCommand, type SSMClient } from "@aws-sdk/client-ssm"
import { describe, expect, it } from "vitest"

import { configSourceFromEnv, loadConfig } from "../../src/adapters/config/config"

const secret = "s".repeat(40)
const apple = {
  apple_team_id: "TEAM000000",
  apple_key_id: "KEY0000000",
  apple_services_id: "app.keepwell.web",
  apple_bundle_id: "app.keepwell.ios",
  apple_private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
  allowed_apple_subs: "a.1, b.2 ,",
}
const ssmParameters = (prefix: string) => Object.entries(apple).map(([key, Value]) => ({ Name: `${prefix}/${key}`, Value }))

function fakeSsm(pages: { Parameters: { Name: string; Value: string }[]; NextToken?: string }[]) {
  const calls: unknown[] = []
  const client = {
    send: async (command: GetParametersByPathCommand) => {
      calls.push(command.input)
      return pages.shift()
    },
  } as unknown as SSMClient
  return { client, calls }
}

describe("configuration", () => {
  it("reads SSM by path, decrypted, across pages, with names relative to the prefix", async () => {
    const { client, calls } = fakeSsm([
      { Parameters: [{ Name: "/keepwell/prod/other", Value: "x" }], NextToken: "t" },
      { Parameters: [{ Name: "/keepwell/prod/auth_secret", Value: secret }, ...ssmParameters("/keepwell/prod")] },
    ])
    const config = await loadConfig({ kind: "ssm", prefix: "/keepwell/prod/" }, client)
    expect(config.auth_secret).toBe(secret)
    expect(config.allowed_apple_subs).toEqual(["a.1", "b.2"])
    expect(calls).toEqual([
      { Path: "/keepwell/prod", Recursive: true, WithDecryption: true, NextToken: undefined },
      { Path: "/keepwell/prod", Recursive: true, WithDecryption: true, NextToken: "t" },
    ])
  })

  it("reads the same keys from a local JSON file in development", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kw-config-"))
    writeFileSync(join(dir, "c.json"), JSON.stringify({ auth_secret: secret, ...apple }))
    expect((await loadConfig({ kind: "file", path: join(dir, "c.json") })).auth_secret).toBe(secret)
  })

  it("refuses the placeholder Terraform writes, naming the key but never the value", async () => {
    const { client } = fakeSsm([{ Parameters: [{ Name: "/keepwell/prod/auth_secret", Value: "unset" }, ...ssmParameters("/keepwell/prod")] }])
    const error = await loadConfig({ kind: "ssm", prefix: "/keepwell/prod" }, client).catch((e: Error) => e)
    expect(String(error)).toContain("auth_secret")
    expect(String(error)).not.toContain("unset")
  })

  it("uses SSM under Lambda and the local file otherwise", () => {
    expect(configSourceFromEnv({ CONFIG_PREFIX: "/keepwell/dev", AWS_REGION: "us-east-1" })).toEqual({ kind: "ssm", prefix: "/keepwell/dev", region: "us-east-1" })
    expect(configSourceFromEnv({})).toEqual({ kind: "file", path: "config.local.json" })
  })
})
