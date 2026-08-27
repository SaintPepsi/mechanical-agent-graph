import { describe, expect, test } from "bun:test"
import { compileChangelog, type ChangelogParams, PR_BODY_PARAMS } from "mag/skills/changelog"

describe("compileChangelog — the PR-body variant (PR_BODY_PARAMS)", () => {
  const compiled = compileChangelog(PR_BODY_PARAMS)

  test("opens straight on the instruction, no front-matter: this variant is spliced into a prompt, never installed", () => {
    expect(compiled.startsWith("Write the pull request description")).toBe(true)
  })

  test("every lead, grouping and exclusions line renders", () => {
    for (const line of PR_BODY_PARAMS.lead) expect(compiled).toContain(line)
    for (const line of PR_BODY_PARAMS.grouping) expect(compiled).toContain(line)
    for (const line of PR_BODY_PARAMS.exclusions) expect(compiled).toContain(line)
  })

  test("the contract-delta heading, trigger and every register line render", () => {
    expect(compiled).toContain(PR_BODY_PARAMS.contractDelta.heading)
    expect(compiled).toContain(PR_BODY_PARAMS.contractDelta.trigger)
    for (const line of PR_BODY_PARAMS.contractDelta.register) expect(compiled).toContain(line)
  })

  // The section is an instruction with a verb ("Add a ... section
  // when ..."), not a bare heading-colon-trigger line — and the heading never starts a line on its
  // own, so it can't be mistaken for a literal markdown H2 splicing itself into the prompt.
  test("the contract-delta line is an instruction, and the heading never opens a line by itself", () => {
    expect(compiled).toContain(
      `Add a \`${PR_BODY_PARAMS.contractDelta.heading}\` section when ${PR_BODY_PARAMS.contractDelta.trigger}.`
    )
    for (const line of compiled.split("\n")) expect(line.startsWith("## ")).toBe(false)
  })

  // Cold-startable. A repo with none of this history still has to be able to follow the
  // standard, so the compiled text (and every string this variant carries) names no ticket, no
  // repo path, and no decision archeology — asserted mechanically, not by reading.
  test("cold-startable: no ticket numbers, no issue references, no repo path fragments", () => {
    expect(compiled).not.toMatch(/GH-\d/)
    expect(compiled).not.toMatch(/#\d/)
    expect(compiled).not.toContain("plugins/")
    expect(compiled).not.toContain("docs/")
  })

  test("cold-startable: every string PR_BODY_PARAMS carries is clean too, not just the compiled join", () => {
    const strings = [
      ...PR_BODY_PARAMS.lead,
      ...PR_BODY_PARAMS.grouping,
      PR_BODY_PARAMS.contractDelta.heading,
      PR_BODY_PARAMS.contractDelta.trigger,
      ...PR_BODY_PARAMS.contractDelta.register,
      ...PR_BODY_PARAMS.exclusions
    ]
    for (const value of strings) {
      expect(value).not.toMatch(/GH-\d/)
      expect(value).not.toMatch(/#\d/)
      expect(value).not.toContain("plugins/")
      expect(value).not.toContain("docs/")
      expect(value.toLowerCase()).not.toContain("ruled")
      expect(value.toLowerCase()).not.toContain("maintainer")
    }
  })
})

describe("compileChangelog — pure: params in, string out", () => {
  test("the same params render the same string twice", () => {
    expect(compileChangelog(PR_BODY_PARAMS)).toBe(compileChangelog(PR_BODY_PARAMS))
  })

  test("a changed rule changes the render — the check is proven to bite, not vacuous", () => {
    const edited: ChangelogParams = { ...PR_BODY_PARAMS, lead: ["a different lead rule entirely"] }
    expect(compileChangelog(edited)).not.toBe(compileChangelog(PR_BODY_PARAMS))
    expect(compileChangelog(edited)).toContain("a different lead rule entirely")
  })

  test("a changed contract-delta trigger changes the render too", () => {
    const edited: ChangelogParams = {
      ...PR_BODY_PARAMS,
      contractDelta: { ...PR_BODY_PARAMS.contractDelta, trigger: "a different trigger entirely" }
    }
    expect(compileChangelog(edited)).not.toBe(compileChangelog(PR_BODY_PARAMS))
    expect(compileChangelog(edited)).toContain("a different trigger entirely")
  })
})
