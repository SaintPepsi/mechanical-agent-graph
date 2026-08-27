import { describe, expect, test } from "bun:test"
import graphMermaidNotation from "mag/docs/envision/graph-mermaid-notation.md" with { type: "text" }
import { envisionDocBody } from "mag/skills/design/concern"
import { compileDeriveVision } from "mag/skills/envision/derivation"

const PARAMS = {
  graphRoot: "graphs/design-graph",
  destination: "/tmp/code-only/derived-vision.md"
}

describe("compileDeriveVision", () => {
  test("names the code path to draw from and the one destination", () => {
    const compiled = compileDeriveVision(PARAMS)
    expect(compiled).toContain(PARAMS.graphRoot)
    expect(compiled).toContain(PARAMS.destination)
  })

  test("hard-imports the notation grammar and splices it whole", () => {
    expect(compileDeriveVision(PARAMS)).toContain(envisionDocBody(graphMermaidNotation))
  })

  test("never carries the envisioning discipline's own line, disconfirming", () => {
    // The discipline document instructs the opposite job ("the current implementation is banned
    // from the frame"); a derivation prompt that quoted it would be asking for both jobs at once.
    expect(compileDeriveVision(PARAMS)).not.toContain("banned from the frame")
  })

  test("pure: the same params render the same string twice, a changed graphRoot changes the render", () => {
    expect(compileDeriveVision(PARAMS)).toBe(compileDeriveVision(PARAMS))
    expect(compileDeriveVision({ ...PARAMS, graphRoot: "graphs/envision" })).not.toBe(compileDeriveVision(PARAMS))
  })
})
