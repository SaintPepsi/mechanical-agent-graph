import { describe, expect, test } from "bun:test"
import graphRailSketch from "mag/docs/envision/graph-rail-sketch.envision.md" with { type: "text" }
import { envisionDocBody } from "mag/skills/design/concern"
import { compileEnvisionRailSketch } from "mag/skills/envision/rail-sketch"

const PARAMS = {
  name: "envision",
  visionPath: "plugins/mag/src/graphs/envision/vision.md",
  destination: "plugins/mag/src/graphs/envision/rail-sketch.md"
}

describe("compileEnvisionRailSketch", () => {
  test("names rail-sketch.md as its only destination and the vision as read-only input, disconfirming", () => {
    const compiled = compileEnvisionRailSketch(PARAMS)
    expect(compiled).toContain(PARAMS.destination)
    expect(compiled).toContain(PARAMS.visionPath)
    expect(compiled).toContain("read-only input")
    expect(compiled).not.toContain("Do not write or commit the vision")
  })

  test("carries the rail-sketch discipline: rails inline, conditions at the wiring site", () => {
    const compiled = compileEnvisionRailSketch(PARAMS)
    expect(compiled).toContain("outside shape")
    expect(compiled).toContain("error tags inline")
    expect(compiled).toContain("where the node is wired")
  })

  test("carries the rule: an ideal, never a whole file", () => {
    const compiled = compileEnvisionRailSketch(PARAMS)
    expect(compiled).toContain("ideal imagination exercise")
    expect(compiled).toContain("never a whole file")
  })

  test("composes the graph-rail-sketch envision doc rather than restating it", () => {
    expect(compileEnvisionRailSketch(PARAMS)).toContain(envisionDocBody(graphRailSketch))
  })

  test("pure: the same params render the same string twice", () => {
    expect(compileEnvisionRailSketch(PARAMS)).toBe(compileEnvisionRailSketch(PARAMS))
  })
})
