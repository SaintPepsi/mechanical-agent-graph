import { Effect, Schema } from "effect"
import { AssertRedGitFailed, AssertRedHeadMoved, AssertRedNoTests } from "mag/graph-nodes/assert-red/errors"
import { make } from "mag/runtime/graph-node.definition"
import { gitRead } from "mag/runtime/git"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/**
 * The classification an exit code maps to. The convention is the whole contract: `0` is green,
 * `1` is red (the runner ran the file and an assertion failed), anything else is broken (the file
 * never ran: a compile error, a missing import, a usage error). A runner that exits `1` for every
 * failure never yields `broken` here; `bun test` is one (probed: an assertion failure, a missing
 * import and a syntax error all exit 1), so on such a runner a broken test reads as red and is
 * caught one stage later, when it stays red after the implementation lands.
 */
const classify = (exitCode: number): "green" | "red" | "broken" =>
  exitCode === 0 ? "green" : exitCode === 1 ? "red" : "broken"

/**
 * Runs each test path through the caller's command and sorts the paths by outcome, with no
 * judgment anywhere: an exit code is the verdict. The command is one shell line run as
 * `sh -c <command> sh <path>`, so it reads the test path as `$1` (`bun test "$1"`); a command that
 * ignores `$1` runs its whole suite once per path, still correct, only coarser. Paths are run one
 * at a time so an outcome belongs to exactly one path.
 *
 * `sha` names the tree this verdict is about and is checked against `HEAD` before anything runs:
 * the journal keys a row on its input, so a `{ testPaths, command }`-only input would let a resumed
 * run replay a classification made against a different tree (`verification/graph-node.ts`'s own
 * reasoning for `headSha`).
 */
export const assertRed = make({
  name: "assert-red",
  description: "Run each test path at a sha and classify it red, green or broken by exit code.",
  input: Schema.Struct({
    testPaths: Schema.Array(Schema.String),
    sha: Schema.String,
    /** One shell line receiving the test path as `$1`. */
    command: Schema.String
  }),
  success: Schema.Struct({
    red: Schema.Array(Schema.String),
    green: Schema.Array(Schema.String),
    broken: Schema.Array(Schema.String)
  }),
  run: (input) =>
    Effect.gen(function* () {
      if (input.testPaths.length === 0) return yield* Effect.fail(new AssertRedNoTests())

      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      const observed = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new AssertRedGitFailed(fields))
      if (observed !== input.sha) return yield* Effect.fail(new AssertRedHeadMoved({ expected: input.sha, observed }))

      const shell = yield* Shell
      const red: string[] = []
      const green: string[] = []
      const broken: string[] = []
      for (const path of input.testPaths) {
        const result = yield* shell.run(["sh", "-c", input.command, "sh", path], { cwd })
        const bucket = classify(result.exitCode)
        if (bucket === "green") green.push(path)
        else if (bucket === "red") red.push(path)
        else broken.push(path)
      }
      return { red, green, broken }
    })
})
