import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { PlanEntry, renderPlan } from "mag/runtime/test-plan"

const ENTRY = {
  name: "reset(key) clears that key only",
  behaviour: "after reset(\"a\"), count(\"b\") is unchanged",
  bugItCatches: "reset clears the whole map",
  negativeSpace: ["a repeated reset is safe", "the caller's key string is not mutated"]
}

describe("test-plan", () => {
  test("bugItCatches is unconstructable empty", () => {
    expect(() => Schema.decodeUnknownSync(PlanEntry)({ ...ENTRY, bugItCatches: "" })).toThrow()
    expect(Schema.decodeUnknownSync(PlanEntry)(ENTRY)).toStrictEqual(ENTRY)
  })

  test("renderPlan numbers each entry and drops an empty negative-space line", () => {
    expect(renderPlan([ENTRY, { ...ENTRY, name: "second", negativeSpace: [] }])).toBe(
      [
        "1. reset(key) clears that key only",
        "   behaviour: after reset(\"a\"), count(\"b\") is unchanged",
        "   bug it catches: reset clears the whole map",
        "   negative space: a repeated reset is safe; the caller's key string is not mutated",
        "2. second",
        "   behaviour: after reset(\"a\"), count(\"b\") is unchanged",
        "   bug it catches: reset clears the whole map"
      ].join("\n")
    )
  })
})
