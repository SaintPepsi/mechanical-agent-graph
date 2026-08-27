import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  Claim,
  ESCAPE_CATEGORIES,
  Escape,
  maxSeverity,
  RatedEscape,
  SEVERITY_BY_CATEGORY,
  severityOf
} from "mag/runtime/suite-escape"

const ESCAPE = { path: "src/limiter.ts", find: "reset(key)", replace: "reset()", probeSource: "bun -e 'console.log(1)'" }

describe("suite-escape", () => {
  test("the severity table is the documented one, every category present exactly once", () => {
    expect(SEVERITY_BY_CATEGORY).toStrictEqual({
      "data-loss": 3,
      isolation: 3,
      durability: 3,
      quota: 2,
      boundary: 1,
      cosmetic: 0
    })
    expect(Object.keys(SEVERITY_BY_CATEGORY).sort()).toStrictEqual([...ESCAPE_CATEGORIES].sort())
  })

  test("severityOf reads the table, not the model: quota is 2, cosmetic is 0", () => {
    expect(severityOf("quota")).toBe(2)
    expect(severityOf("cosmetic")).toBe(0)
  })

  test("maxSeverity is the worst rating, 0 for an empty set", () => {
    expect(maxSeverity([])).toBe(0)
    expect(
      maxSeverity([
        { ...ESCAPE, category: "boundary", severity: 1 },
        { ...ESCAPE, category: "isolation", severity: 3 },
        { ...ESCAPE, category: "quota", severity: 2 }
      ])
    ).toBe(3)
  })

  test("a rated escape refuses a category outside the closed list", () => {
    expect(() => Schema.decodeUnknownSync(RatedEscape)({ ...ESCAPE, category: "catastrophic", severity: 3 })).toThrow()
  })

  test("a claim needs its rationale; an escape drops it", () => {
    expect(() => Schema.decodeUnknownSync(Claim)(ESCAPE)).toThrow()
    expect(Schema.decodeUnknownSync(Escape)({ ...ESCAPE, rationale: "dropped" })).toStrictEqual(ESCAPE)
  })
})
