import { describe, expect, test } from "bun:test"
import graphMermaidNotation from "mag/docs/envision/graph-mermaid-notation.md" with { type: "text" }
import graphMermaidVision from "mag/docs/envision/graph-mermaid-vision.envision.md" with { type: "text" }
import { envisionDocBody } from "mag/skills/design/concern"
import { compileEnvisionMermaid } from "mag/skills/envision/mermaid"

const PARAMS = { name: "envision", destination: "plugins/mag/src/graphs/envision/vision.md" }

describe("compileEnvisionMermaid", () => {
  test("names its own destination and never the rail-sketch's, disconfirming", () => {
    const compiled = compileEnvisionMermaid(PARAMS)
    expect(compiled).toContain(PARAMS.destination)
    expect(compiled).not.toContain("rail-sketch.md")
  })

  test("carries the graph name and the full-granularity contract", () => {
    const compiled = compileEnvisionMermaid(PARAMS)
    expect(compiled).toContain(PARAMS.name)
    expect(compiled).toContain("branch names, checkouts")
  })

  test("hard-imports the envision doc and splices it whole", () => {
    expect(compileEnvisionMermaid(PARAMS)).toContain(envisionDocBody(graphMermaidVision))
  })

  // The notation grammar is split out of the envision doc into its own document, spliced back in
  // after the discipline. Pins both halves into this node's own output —
  // `skills/envision/derivation.test.ts` carries the same pin on the other splicer.
  test("hard-imports the notation grammar and splices it too", () => {
    expect(compileEnvisionMermaid(PARAMS)).toContain(envisionDocBody(graphMermaidNotation))
  })

  test("pure: the same params render the same string twice, a changed name changes the render", () => {
    expect(compileEnvisionMermaid(PARAMS)).toBe(compileEnvisionMermaid(PARAMS))
    expect(compileEnvisionMermaid({ ...PARAMS, name: "design" })).not.toBe(compileEnvisionMermaid(PARAMS))
  })
})
