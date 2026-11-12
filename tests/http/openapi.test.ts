import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { SYNC_ENTITIES } from "../../src/core/domain/schema"
import { openApiDocument } from "../../src/entrypoints/http/openapi"

describe("OpenAPI", () => {
  it("is generated from the schemas that validate requests, and the committed copy is current", () => {
    const committed = JSON.parse(readFileSync("docs/openapi.json", "utf8"))
    expect(committed, "run pnpm openapi").toEqual(JSON.parse(JSON.stringify(openApiDocument())))
  })

  it("describes every sync entity's row", () => {
    const schemas = Object.keys(openApiDocument().components.schemas)
    expect(schemas.filter((name) => name.startsWith("Row.")).length).toBe(SYNC_ENTITIES.length)
  })
})
