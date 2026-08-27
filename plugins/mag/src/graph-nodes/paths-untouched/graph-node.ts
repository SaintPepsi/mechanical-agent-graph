import { Effect, Schema } from "effect"
import { PathsTouched, PathsUntouchedGitFailed } from "mag/graph-nodes/paths-untouched/errors"
import { make } from "mag/runtime/graph-node.definition"
import { gitRead } from "mag/runtime/git"
import { RunInfo, workdir } from "mag/runtime/run-info"

/**
 * A gate with no judgment in it: `git diff --name-only <from> <to>` intersected with the forbidden
 * paths, non-empty is the failure. Success carries nothing because the whole fact is that the gate
 * passed; a caller composes on the absence of {@link PathsTouched}.
 */
export const pathsUntouched = make({
  name: "paths-untouched",
  description: "Fail when a commit range touches any of the given paths.",
  input: Schema.Struct({
    paths: Schema.Array(Schema.String),
    fromSha: Schema.String,
    toSha: Schema.String
  }),
  success: Schema.Struct({}),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const changed = yield* gitRead(
        ["git", "diff", "--name-only", input.fromSha, input.toSha],
        workdir(runInfo),
        (fields) => new PathsUntouchedGitFailed(fields)
      )
      const touched = new Set(changed.split("\n").filter((line) => line !== ""))
      const paths = input.paths.filter((path) => touched.has(path))
      if (paths.length > 0) {
        return yield* Effect.fail(new PathsTouched({ paths, fromSha: input.fromSha, toSha: input.toSha }))
      }
      return {}
    })
})
