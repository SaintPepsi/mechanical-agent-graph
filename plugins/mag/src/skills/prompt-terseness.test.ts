import { describe, expect, test } from "bun:test"
import { compilePromptTerseness, EVALUATOR_PARAMS, type TersenessParams } from "mag/skills/prompt-terseness"

describe("compilePromptTerseness — evaluator variant (EVALUATOR_PARAMS)", () => {
  const compiled = compilePromptTerseness(EVALUATOR_PARAMS)

  test("opens straight on the instruction, no front-matter: this variant is spliced into a prompt, never installed", () => {
    expect(compiled.startsWith("Rewrite every verbose prompt")).toBe(true)
  })

  test("every rule and every scope line renders", () => {
    for (const rule of EVALUATOR_PARAMS.rules) expect(compiled).toContain(rule)
    for (const line of EVALUATOR_PARAMS.scope) expect(compiled).toContain(line)
  })

  test("cold-startable: states the rule with no repo-specific references", () => {
    expect(compiled).toContain("one instruction, one line")
    expect(compiled).not.toContain("PRINCIPLES.md")
    expect(compiled).not.toMatch(/GH-\d|#\d/)
  })
})

describe("compilePromptTerseness — pure: params in, string out", () => {
  test("the same params render the same string twice", () => {
    expect(compilePromptTerseness(EVALUATOR_PARAMS)).toBe(compilePromptTerseness(EVALUATOR_PARAMS))
  })

  test("a changed rule changes the render — the check is proven to bite, not vacuous", () => {
    const edited: TersenessParams = { ...EVALUATOR_PARAMS, rules: ["a different rule entirely"] }
    expect(compilePromptTerseness(edited)).not.toBe(compilePromptTerseness(EVALUATOR_PARAMS))
    expect(compilePromptTerseness(edited)).toContain("a different rule entirely")
  })
})
