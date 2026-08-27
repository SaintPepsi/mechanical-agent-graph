import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { join } from "node:path"
import { isAllowedImport, TEST_SUPPORT_MODULES } from "mag/runtime/graph-node.shape"

/**
 * "No `graph-nodes/` file ever holds tracing code" is a mechanical, scripted check —
 * house rule "mechanical before model" (root CLAUDE.md) — not a review instruction. It scans real
 * source text under `plugins/mag/src/graph-nodes/`, so it stays true both trivially today (no node
 * file holds tracing code) and forever after: a future PR that imports the tracing
 * subsystem, or even just name-drops one of its exports, from a node file goes red here.
 *
 * `mag/runtime/trace/fold` (used below as the "load-bearing" allowlist case) is allowed
 * with no code change needed, by the existing `mag/runtime/` allow-rule row
 * (`graph-node.shape.ts`'s `ALLOW_RULES`: `(specifier) => specifier === "mag/runtime" || specifier.startsWith("mag/runtime/")`).
 * That row is *why* the allowlist clause below needs no change — tracing code lives under
 * `src/runtime/trace/`, already inside the allowed prefix. A future edit that moved tracing code out
 * from under `src/runtime/` would break the "still unchanged" case below, which is the alarm working
 * as intended, not a false failure to "fix".
 */

const nodesDir = join(import.meta.dir, "..", "src", "graph-nodes")

/**
 * An import of the tracing subsystem, or a bare name-drop of one of its exports/wire-format prefix.
 *
 * A bare `"mag:"` would over-match any unrelated text that happens to contain that word and a
 * colon. `console-sink.ts`'s formatters always emit the full prefix, `mag: [${name}]...`, so
 * `"mag: ["` is the actual wire-format text this token exists to catch, and it catches nothing else.
 */
const FORBIDDEN_TOKENS = ["mag/runtime/trace", "TraceEvent", "TraceSink", "foldTrace", "tracedRun", "mag: ["] as const

describe("tracing conformance — no node file holds tracing code", () => {
  test("no .ts file under graph-nodes/ imports the tracing subsystem or references its vocabulary", async () => {
    const violations: string[] = []

    for await (const file of new Glob("**/*.ts").scan({ cwd: nodesDir, onlyFiles: true, dot: true })) {
      const source = await Bun.file(join(nodesDir, file)).text()
      for (const token of FORBIDDEN_TOKENS) {
        if (source.includes(token)) violations.push(`${file}: contains forbidden tracing token ${JSON.stringify(token)}`)
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `GraphNode files must never reference the tracing subsystem (boundary code alone traces, invisibly ` +
          `to node authors). Offending file(s):\n${violations.join("\n")}`
      )
    }

    expect(violations).toEqual([])
  })

  // The other half of this guarantee — "a node that holds no tracing code still writes both events" — is
  // proven end to end in `test/tracing.test.ts`: the conformance node above holds no tracing code
  // and is shown there to produce exactly two `mag:` lines. That is the positive half;
  // this file only proves the negative (no node ever imports tracing).

  describe("the import allowlist of the conformance check stays unchanged", () => {
    test("TEST_SUPPORT_MODULES is still exactly mag/test/node-fixture", () => {
      expect(TEST_SUPPORT_MODULES).toEqual(["mag/test/node-fixture"])
    })

    test("isAllowedImport still answers the same for one representative specifier per allow-rule row", () => {
      const nodeName = "conformance"

      // effect/... row
      expect(isAllowedImport("effect/Effect", nodeName)).toBe(true)
      // node:... row
      expect(isAllowedImport("node:fs", nodeName)).toBe(true)
      // bun:... row
      expect(isAllowedImport("bun:test", nodeName)).toBe(true)
      // mag/runtime row
      expect(isAllowedImport("mag/runtime", nodeName)).toBe(true)
      // load-bearing case: tracing code lives under mag/runtime/trace/*, already covered by the
      // mag/runtime/ row above — see this file's header comment for why that matters.
      expect(isAllowedImport("mag/runtime/trace/fold", nodeName)).toBe(true)
      // self-directory row
      expect(isAllowedImport(`mag/graph-nodes/${nodeName}/foo`, nodeName)).toBe(true)
      // another node's directory specifier — not the caller's own, so rejected
      expect(isAllowedImport("mag/graph-nodes/other/foo", nodeName)).toBe(false)
      // relative path — rejected
      expect(isAllowedImport("./foo", nodeName)).toBe(false)
      // bare module name — rejected: only node:-prefixed and bun:-prefixed count, not bare names
      expect(isAllowedImport("fs", nodeName)).toBe(false)
    })
  })
})
