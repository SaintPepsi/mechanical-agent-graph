import { describe, expect, test } from "bun:test"
import { runHarness } from "./run-harness"
import { nonEmptyLines, stripTraceLines } from "./stderr"

/**
 * Real subprocess integration test: `runHarness` pointed at the real `src/cli.ts` entry point —
 * the actual registered `mag topology` command over the actual `develop-graph`, not a fixture
 * registry. `src/topology.test.ts` exercises the pure half; this file is the one
 * place the whole "raw" registry wiring — flag parsing, `SOURCE_ROOTS`, stdout — is proven end to
 * end, the same split `conformance.test.ts` already uses for its own real-CLI half.
 */
describe("topology — the real CLI end to end", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("--graph build-under-review exits 0 with a fenced mermaid block on stdout", async () => {
    const { stdout, stderr, exitCode } = await run("topology", "--graph", "build-under-review")

    expect(exitCode).toBe(0)
    expect(stripTraceLines(stderr)).toBe("")
    expect(stdout).toContain("## build-under-review")
    expect(stdout).toContain("```mermaid")
    expect(stdout).toContain("flowchart TD")
    // The composite's own send-back loop is visible as a repeat subgraph. develop-graph
    // itself is a rail-DSL construct the `.run(` scan cannot see, so it reads as an empty level —
    // the limitation `src/topology.test.ts` pins directly.
    expect(stdout).toContain("subgraph repeat")
  })

  test("an unknown --graph name exits non-zero with TOPOLOGY_SOURCE_MISSING on stderr and nothing on stdout", async () => {
    const { stdout, stderr, exitCode } = await run("topology", "--graph", "not-a-real-graph")

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe("")
    expect(nonEmptyLines(stripTraceLines(stderr)).some((line) => line.startsWith("TOPOLOGY_SOURCE_MISSING"))).toBe(
      true
    )
  })
})
