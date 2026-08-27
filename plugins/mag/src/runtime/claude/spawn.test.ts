import { describe, expect, test } from "bun:test"
import { buildArgv, DEFAULT_BOUNDS, DEFAULT_MODEL, type SpawnRequest } from "mag/runtime/claude/spawn"

const request = (overrides: Partial<SpawnRequest>): SpawnRequest => ({
  prompt: "p",
  bounds: DEFAULT_BOUNDS,
  ...overrides
})

describe("buildArgv model default", () => {
  test("a request naming no model gets --model " + DEFAULT_MODEL, () => {
    const argv = buildArgv("claude", request({}))
    const at = argv.indexOf("--model")
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe(DEFAULT_MODEL)
  })

  test("a named model wins over the default", () => {
    const argv = buildArgv("claude", request({ model: "opus" }))
    const at = argv.indexOf("--model")
    expect(argv[at + 1]).toBe("opus")
  })

  test("the default rides along even when an agent is named", () => {
    const argv = buildArgv("claude", request({ agent: "effect-expert" }))
    const at = argv.indexOf("--model")
    expect(argv[at + 1]).toBe(DEFAULT_MODEL)
  })
})
