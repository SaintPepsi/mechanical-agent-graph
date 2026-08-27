import { Effect, FileSystem, Schema } from "effect"
import { TestSmellsUnreadable } from "mag/graph-nodes/test-smells/errors"
import { inspectSource } from "mag/graph-nodes/test-smells/smells"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo } from "mag/runtime/run-info"

const Finding = Schema.Struct({
  path: Schema.String,
  severity: Schema.Literals(["error", "warn"]),
  rule: Schema.String,
  line: Schema.Int,
  message: Schema.String
})

/**
 * The mechanical sweep of the adversarial review lane, `detect-svelte`'s reasoning applied to test
 * text: everything decidable by reading the file (no assertion, a stranded `.then`, a matcher that
 * accepts anything) costs no tokens and cannot be argued with. Findings are a verdict, not a
 * failure: which severity a graph acts on is the composite's decision. Paths resolve against
 * `RunInfo.workRoot`, the tree the tests were written into.
 */
export const testSmells = make({
  name: "test-smells",
  description: "Read JS/TS test files for the flaws decidable by text alone, with no model session.",
  input: Schema.Struct({ testPaths: Schema.Array(Schema.String) }),
  success: Schema.Struct({ findings: Schema.Array(Finding), tests: Schema.Int }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const fs = yield* FileSystem.FileSystem
      const findings: Array<typeof Finding.Type> = []
      let tests = 0
      for (const path of input.testPaths) {
        const absolute = runInfo.workRoot === "" ? path : `${runInfo.workRoot}/${path}`
        const source = yield* fs.readFileString(absolute).pipe(
          Effect.catch((error) => Effect.fail(new TestSmellsUnreadable({ path, detail: String(error) })))
        )
        const inspected = inspectSource(path, source)
        findings.push(...inspected.findings)
        tests += inspected.tests
      }
      return { findings, tests }
    }).pipe(Effect.provide(platform))
})
