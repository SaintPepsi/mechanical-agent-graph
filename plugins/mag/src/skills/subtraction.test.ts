import { describe, expect, test } from "bun:test"
import { compileSubtraction, SIMPLIFY_PARAMS, type SubtractionParams } from "mag/skills/subtraction"

/**
 * Pure params-in-string-out tests, `installed.test.ts`'s bite-proof shape (perturb a param,
 * confirm the render moves). No drift-against-disk test here — unlike the installed skill, this
 * standard is never materialized to a file, so there is nothing on disk to drift against.
 */
describe("compileSubtraction", () => {
  const compiled = compileSubtraction(SIMPLIFY_PARAMS)

  test("carries every reduction and every limit, verbatim", () => {
    for (const reduction of SIMPLIFY_PARAMS.reductions) expect(compiled).toContain(reduction)
    for (const limit of SIMPLIFY_PARAMS.limits) expect(compiled).toContain(limit)
  })

  test("the five reduction categories are present", () => {
    expect(compiled).toContain("Reuse over duplication")
    expect(compiled).toContain("Dead branches removed")
    expect(compiled).toContain("Needless indirection collapsed")
    expect(compiled).toContain("Comments that don't earn their place deleted")
    expect(compiled).toContain("Prompt text compressed to terse one-liners")
  })

  test("the specimen: a justification comment excusing a duplicate is itself a finding", () => {
    expect(compiled).toContain("A comment excusing a duplicate is itself a finding")
  })

  test("is pure: the same params render the same string every time", () => {
    expect(compileSubtraction(SIMPLIFY_PARAMS)).toBe(compiled)
  })

  test("a changed param changes the render, proving the check above can bite", () => {
    const edited: SubtractionParams = { ...SIMPLIFY_PARAMS, reductions: [...SIMPLIFY_PARAMS.reductions, "extra"] }
    expect(compileSubtraction(edited)).not.toBe(compiled)
  })
})
