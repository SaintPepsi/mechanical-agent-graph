import { Effect, Schema } from "effect"
import { WorktreePathUnset, WorktreeRemoveFailed } from "mag/graph-nodes/worktree-remove/errors"
import { make } from "mag/runtime/graph-node.definition"
import { primaryDir, RunInfo } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/**
 * Retires a worktree `worktree-add` created. Takes `path` as input rather than reading
 * `RunInfo.workRoot`, so the dataflow is visible in the graph file and the journal row says exactly
 * what was removed. The refusal to ever target the primary checkout is checked here too, on the
 * input rather than on `workRoot`, since that is the value this node actually acts on.
 *
 * `git worktree remove` runs from the primary checkout, never from inside the tree being removed —
 * removing your own cwd is not a thing to attempt. `--force` is never passed, under any condition:
 * git already refuses a dirty tree on its own, and by the time this runs `push-branch`'s own
 * clean-tree guard has already passed, so a clean tree is an invariant the pipeline establishes
 * rather than a hope. If it is somehow false, git refuses and the run errors with the tree kept,
 * which is the safe outcome either way.
 */
export const worktreeRemove = make({
  name: "worktree-remove",
  description: "Remove a worktree this run created, from the primary checkout.",
  input: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({ path: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const runInfo = yield* RunInfo
      if (input.path === "" || input.path === runInfo.repoRoot) {
        return yield* Effect.fail(new WorktreePathUnset({ path: input.path }))
      }
      const cwd = primaryDir(runInfo)

      const removed = yield* shell.run(["git", "worktree", "remove", input.path], { cwd })
      if (removed.exitCode !== 0) {
        return yield* Effect.fail(
          new WorktreeRemoveFailed({ path: input.path, exitCode: removed.exitCode, stderr: removed.stderr.trim() })
        )
      }

      return { path: input.path }
    })
})
