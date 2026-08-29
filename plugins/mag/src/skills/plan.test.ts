import { describe, expect, test } from "bun:test"
import { compilePlan, PLAN_DESTINATION, PLAN_PARAMS, type PlanParams } from "mag/skills/plan"

/** Pure params-in-string-out tests, `subtraction.test.ts`'s shape: never materialized to disk, so nothing to drift against. */
describe("compilePlan", () => {
  const compiled = compilePlan(PLAN_PARAMS)

  test("carries every section and every rule, verbatim, sections first", () => {
    for (const section of PLAN_PARAMS.sections) expect(compiled).toContain(section)
    for (const rule of PLAN_PARAMS.rules) expect(compiled).toContain(rule)
    expect(compiled.indexOf(PLAN_PARAMS.sections[0]!)).toBeLessThan(compiled.indexOf(PLAN_PARAMS.rules[0]!))
  })

  test("the four parts of a plan are present: goal, resolution table, tasks, criteria map", () => {
    expect(compiled).toContain("Goal:")
    expect(compiled).toContain("Resolution table:")
    expect(compiled).toContain("Tasks:")
    expect(compiled).toContain("Criteria map:")
  })

  test("renders in section order: perturbing the order moves the render", () => {
    const reversed: PlanParams = { ...PLAN_PARAMS, sections: [...PLAN_PARAMS.sections].reverse() }
    expect(compilePlan(reversed)).not.toBe(compiled)
  })

  test("is pure: the same params render the same string every time", () => {
    expect(compilePlan(PLAN_PARAMS)).toBe(compiled)
  })

  test("the destination is ticket-tokenised beside the design and discover records", () => {
    expect(PLAN_DESTINATION).toBe("docs/graph/<TICKET>/plan.md")
  })
})
