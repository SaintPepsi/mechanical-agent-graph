import { describe, expect, test } from "bun:test"
import { compare, renderReport } from "mag/graph-nodes/compare-vision/compare"
import type { Shape } from "mag/runtime/vision-shape"

const EMPTY: Shape = { nodes: [], edges: [], conditions: [] }

const SHAPE: Shape = {
  nodes: ["load", "transform"],
  edges: ["load -> transform"],
  conditions: ["load -> transform when verdict = ok"]
}

describe("compare", () => {
  test("identical shapes produce no findings, even non-empty ones", () => {
    expect(compare(SHAPE, SHAPE)).toStrictEqual([])
    expect(compare(EMPTY, EMPTY)).toStrictEqual([])
  })

  test("a renamed node surfaces as exactly the absent/unexpected pair, never matched across the rename", () => {
    const renamed: Shape = { ...SHAPE, nodes: ["load", "convert"] }
    expect(compare(SHAPE, renamed)).toStrictEqual([
      { kind: "node-absent-from-code", name: "transform" },
      { kind: "node-absent-from-vision", name: "convert" }
    ])
  })

  test("a dropped edge is edge-absent-from-code, the declared side named", () => {
    const noEdge: Shape = { ...SHAPE, edges: [] }
    expect(compare(SHAPE, noEdge)).toStrictEqual([{ kind: "edge-absent-from-code", name: "load -> transform" }])
  })

  test("an edge the code gained is edge-absent-from-vision", () => {
    const extraEdge: Shape = { ...SHAPE, edges: [...SHAPE.edges, "transform -> load"] }
    expect(compare(SHAPE, extraEdge)).toStrictEqual([{ kind: "edge-absent-from-vision", name: "transform -> load" }])
  })

  test("a dropped condition is condition-absent-from-code", () => {
    const noCondition: Shape = { ...SHAPE, conditions: [] }
    expect(compare(SHAPE, noCondition)).toStrictEqual([
      { kind: "condition-absent-from-code", name: "load -> transform when verdict = ok" }
    ])
  })

  test("a condition the code gained is condition-absent-from-vision", () => {
    const extra = "load -> transform when verdict = retry"
    const extraCondition: Shape = { ...SHAPE, conditions: [...SHAPE.conditions, extra] }
    expect(compare(SHAPE, extraCondition)).toStrictEqual([{ kind: "condition-absent-from-vision", name: extra }])
  })

  test("every direction of every kind fires together on a shape with nothing in common", () => {
    const other: Shape = { nodes: ["x"], edges: ["x -> y"], conditions: ["x -> y when verdict = z"] }
    const findings = compare(SHAPE, other)
    const kinds = new Set(findings.map((finding) => finding.kind))
    expect([...kinds].sort()).toStrictEqual([
      "condition-absent-from-code",
      "condition-absent-from-vision",
      "edge-absent-from-code",
      "edge-absent-from-vision",
      "node-absent-from-code",
      "node-absent-from-vision"
    ])
  })
})

describe("renderReport", () => {
  test("a clean pass still writes a file, saying plainly that nothing diverged", () => {
    const report = renderReport("/repo/graphs/x/vision.md", "/run/derived-vision-1.md", [])
    expect(report).toContain("/repo/graphs/x/vision.md")
    expect(report).toContain("/run/derived-vision-1.md")
    expect(report).toContain("No divergence")
  })

  test("a divergent pass lists every finding by kind and name", () => {
    const findings = compare(SHAPE, { ...SHAPE, nodes: ["load"] })
    const report = renderReport("/repo/graphs/x/vision.md", "/run/derived-vision-1.md", findings)
    expect(report).toContain("node-absent-from-code: transform")
  })
})
