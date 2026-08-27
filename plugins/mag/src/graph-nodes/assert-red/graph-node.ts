import { Effect, Schema } from "effect"
import { AssertRedGitFailed, AssertRedHeadMoved, AssertRedNoTests } from "mag/graph-nodes/assert-red/errors"
import { make } from "mag/runtime/graph-node.definition"
import { gitRead } from "mag/runtime/git"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/**
 * Runs each test path through the caller's command and sorts the paths by outcome, with no
 * judgment anywhere: exit 0 is green, anything else is red. The command is one shell line run as
 * `sh -c <command> sh <path>`, so it reads the test path as `$1` (`bun test "$1"`); a command that
 * ignores `$1` runs its whole suite once per path, still correct, only coarser. Paths are run one
 * at a time so an outcome belongs to exactly one path. Whether a test file compiles is not this
 * node's question: `write-red` owes a compiling test and its stubs, and the loop that dispatches
 * it gates that mechanically before asking here.
 *
 * `sha` names the tree this verdict is about and is checked against `HEAD` before anything runs:
 * the journal keys a row on its input, so a `{ testPaths, command }`-only input would let a resumed
 * run replay a classification made against a different tree (`verification/graph-node.ts`'s own
 * reasoning for `headSha`).
 */
export const assertRed = make({
  name: "assert-red",
  description: "Run each test path at a sha and classify it red or green by exit code.",
  input: Schema.Struct({
    testPaths: Schema.Array(Schema.String),
    sha: Schema.String,
    /** One shell line receiving the test path as `$1`. */
    command: Schema.String
  }),
  success: Schema.Struct({
    red: Schema.Array(Schema.String),
    green: Schema.Array(Schema.String)
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
      for (const path of input.testPaths) {
        const result = yield* shell.run(["sh", "-c", input.command, "sh", path], { cwd })
        if (result.exitCode === 0) green.push(path)
        else red.push(path)
      }
      return { red, green }
    })
})
