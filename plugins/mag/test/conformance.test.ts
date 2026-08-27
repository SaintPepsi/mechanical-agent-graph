import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { conformance } from "mag/graph-nodes/conformance/graph-node"
import { nodeFixture } from "mag/test/node-fixture"
import { runHarness } from "mag/test/run-harness"
import { nonEmptyLines, stripTraceLines } from "mag/test/stderr"

/**
 * In-process, no subprocess: `conformance.run({})` invoked directly (no `--root`,
 * so it defaults to the real shipped `plugins/mag/src/graph-nodes/` tree) is the sweep covering
 * `graph-nodes/conformance/` itself, including its own eight files (the four required plus its four
 * owned helpers). `create` is asserted
 * alongside `conformance` explicitly — both hand-written CLI nodes are asserted by name here, not
 * inferred from the run succeeding at all (a violation anywhere in the tree fails the whole run, but
 * a name check proves the sweep actually reached them).
 */
describe("conformance — the shipped tree sweeps itself", () => {
  test("conformance.run({}) succeeds against the real shipped graph-nodes/ tree, checking both create and conformance", async () => {
    const result = await Effect.runPromise(conformance.run({}))

    expect(result.checked).toContain("conformance")
    expect(result.checked).toContain("create")
  })
})

/** One conforming node's on-disk shape, reused by both the "conforming root" and "broken root" fixtures below. */
const conformingSpec = {
  name: "sample",
  files: {
    "graph-node.ts": [
      "import { Effect, Schema } from \"effect\"",
      "import { make } from \"mag/runtime/graph-node.definition\"",
      "",
      "export const sample = make({",
      "  name: \"sample\",",
      "  description: \"A conforming fixture node for subprocess tests.\",",
      "  input: Schema.Struct({ value: Schema.String }),",
      "  success: Schema.Struct({ value: Schema.String }),",
      "  run: (input) => Effect.succeed({ value: input.value })",
      "})",
      ""
    ].join("\n"),
    "errors.ts": [
      "import { Data } from \"effect\"",
      "",
      "export class SampleError extends Data.TaggedError(\"SAMPLE_ERROR\")<{ readonly detail: string }> {}",
      ""
    ].join("\n"),
    "graph-node.test.ts": "// source-only: never dynamically imported by the conformance sweep\n",
    "examples.ts": [
      "export const inputExamples = [{ value: \"hi\" }]",
      "export const successExamples = [{ value: \"hi\" }]",
      ""
    ].join("\n")
  }
}

/** The same node, except `graph-node.ts` carries one disallowed bare import — a single clean import-surface violation. */
const brokenSpec = {
  name: "broken",
  files: {
    ...conformingSpec.files,
    "graph-node.ts": [
      "import { Effect, Schema } from \"effect\"",
      "import { make } from \"mag/runtime/graph-node.definition\"",
      "import \"fs\"",
      "",
      "export const broken = make({",
      "  name: \"broken\",",
      "  description: \"A broken fixture node for subprocess tests.\",",
      "  input: Schema.Struct({ value: Schema.String }),",
      "  success: Schema.Struct({ value: Schema.String }),",
      "  run: (input) => Effect.succeed({ value: input.value })",
      "})",
      ""
    ].join("\n")
  }
}

/**
 * Real subprocess integration test, via `runHarness` pointed at the real `src/cli.ts` entry point —
 * the actual registered `node conformance` command, not the fixture registry `test/harness-cli.ts`
 * points at.
 */
describe("conformance — the real CLI end to end", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("a conforming --root exits 0 with exactly one JSON line on stdout and nothing on stderr", async () => {
    const fixture = nodeFixture([conformingSpec])
    try {
      const { stdout, stderr, exitCode } = await run("node", "conformance", "--root", fixture.root)

      expect(exitCode).toBe(0)
      expect(stripTraceLines(stderr)).toBe("")
      const lines = nonEmptyLines(stdout)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0])
      expect(parsed.checked).toEqual(["sample"])
    } finally {
      fixture.cleanup()
    }
  })

  test("a broken --root exits non-zero, writes nothing to stdout, and names the node/rule/file on one stderr line", async () => {
    const fixture = nodeFixture([brokenSpec])
    try {
      const { stdout, stderr, exitCode } = await run("node", "conformance", "--root", fixture.root)

      expect(exitCode).not.toBe(0)
      expect(stdout).toBe("")

      const lines = nonEmptyLines(stripTraceLines(stderr))
      expect(lines.length).toBe(1)
      const match = /^CONFORMANCE_VIOLATIONS: (\{.*\})$/.exec(lines[0])
      expect(match).not.toBeNull()

      const parsed = JSON.parse(match![1])
      expect(Array.isArray(parsed.violations)).toBe(true)
      expect(parsed.violations.length).toBeGreaterThan(0)
      for (const violation of parsed.violations) {
        expect(typeof violation.node).toBe("string")
        expect(typeof violation.rule).toBe("string")
        expect(typeof violation.file).toBe("string")
      }
      expect(parsed.violations).toContainEqual(
        expect.objectContaining({ node: "broken", rule: "import-surface" })
      )
    } finally {
      fixture.cleanup()
    }
  })

  test("--name nope exits non-zero with a CONFORMANCE_UNKNOWN_NODE stderr line", async () => {
    const fixture = nodeFixture([conformingSpec])
    try {
      const { stderr, exitCode } = await run("node", "conformance", "--name", "nope", "--root", fixture.root)

      expect(exitCode).not.toBe(0)
      const lines = nonEmptyLines(stripTraceLines(stderr))
      expect(lines.length).toBe(1)
      expect(lines[0]).toStartWith("CONFORMANCE_UNKNOWN_NODE:")
      const match = /^CONFORMANCE_UNKNOWN_NODE: (\{.*\})$/.exec(lines[0])
      expect(match).not.toBeNull()
      const parsed = JSON.parse(match![1])
      expect(parsed.name).toBe("nope")
    } finally {
      fixture.cleanup()
    }
  })
})

describe("conformance — help surface", () => {
  const run = runHarness(`${import.meta.dir}/../src/cli.ts`)

  test("mag node --help exits 0 and lists the conformance command", async () => {
    const { stdout, exitCode } = await run("node", "--help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("conformance")
    expect(stdout).toContain("Check every GraphNode directory against the required shape.")
  })

  test("mag node conformance --help exits 0 and lists its flags", async () => {
    const { stdout, exitCode } = await run("node", "conformance", "--help")

    expect(exitCode).toBe(0)
    expect(stdout).toContain("--name")
    expect(stdout).toContain("--root")
  })
})
