import { describe, expect, it } from "vitest"

import fixtures from "../../src/core/domain/fixtures/entities.json"
import { ENTITY_SCHEMAS, type EntityFixtures, type FixtureEntity } from "../../src/core/domain/fixtures"

// The same cases keepwell-web and keepwell-ios run. If this fails after a fresh copy, the copy is
// out of date with the web; if it fails without one, someone edited the copy.
const data = fixtures as EntityFixtures

describe("shared entity fixtures", () => {
  it("covers every sync entity", () => {
    expect(Object.keys(data.entities).sort()).toEqual(Object.keys(ENTITY_SCHEMAS).sort())
  })

  for (const entity of Object.keys(ENTITY_SCHEMAS) as FixtureEntity[]) {
    const schema = ENTITY_SCHEMAS[entity]
    const { valid, invalid } = data.entities[entity]
    it.each(valid.map((c) => [c.name, c] as const))(`${entity} accepts %s`, (_, c) => {
      expect(schema.safeParse(c.value).success).toBe(true)
    })
    it.each(invalid.map((c) => [c.name, c] as const))(`${entity} rejects %s`, (_, c) => {
      expect(schema.safeParse(c.value).success).toBe(false)
    })
  }
})
