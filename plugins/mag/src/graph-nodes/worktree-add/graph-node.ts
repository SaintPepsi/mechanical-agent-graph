import { Effect, Schema } from "effect"
import { WorktreeAddFailed, WorktreePathUnset, WorktreeSetupFailed } from "mag/graph-nodes/worktree-add/errors"
import { make } from "mag/runtime/graph-node.definition"
import { primaryDir, RunInfo } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/** Enough for the failing command's tail; `verification`'s own convention (`graph-nodes/verification/graph-node.ts`). */
const TAIL_CAP = 4000

const tailOf = (stdout: string, stderr: string): string => `${stdout}\n${stderr}`.trim().slice(-TAIL_CAP)

/**
 * Materializes the run's isolated checkout at `RunInfo.workRoot`, composed and frozen by
 * `run-layers.ts` before this node ever runs. `--detach` is mandatory and deliberate: a plain
 * `git worktree add` cannot succeed on a repo whose base is checked out in the primary tree, which is
 * the normal case, and a detached add leaves the branch decision entirely to `branch`, which already
 * knows how to make it safely — the branch node creates or adopts the branch itself, and a detached
 * add can never collide with a branch some other worktree holds.
 *
 * A failure here falls out of nodes that already exist: an occupied path or an unresolvable base both
 * surface as git's own exit 128, and a pre-existing ticket branch held by another tree surfaces as
 * `branch`'s own `BranchCheckoutFailed` one step later. No new probe is written — a probe would
 * duplicate a check git performs atomically and would be racy where git is not.
 *
 * The setup command is per-repository policy, declared by the graph file exactly the way
 * `VERIFICATION_COMMAND` already is: a fresh worktree has no `node_modules` — the first line of
 * `.gitignore` — so the mode is inert without one. This node learns nothing about what the command
 * is; it runs whatever string it is handed, through `sh -c`, in the tree it just created.
 */
export const worktreeAdd = make({
  name: "worktree-add",
  description: "Materialize a detached git worktree at the run's execution root, then run the declared setup command.",
  input: Schema.Struct({ base: Schema.String, setup: Schema.optional(Schema.String) }),
  success: Schema.Struct({ path: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const runInfo = yield* RunInfo
      if (runInfo.workRoot === "" || runInfo.workRoot === runInfo.repoRoot) {
        return yield* Effect.fail(new WorktreePathUnset({ path: runInfo.workRoot }))
      }
      const cwd = primaryDir(runInfo)

      const add = yield* shell.run(["git", "worktree", "add", "--detach", runInfo.workRoot, input.base], { cwd })
      if (add.exitCode !== 0) {
        return yield* Effect.fail(
          new WorktreeAddFailed({
            path: runInfo.workRoot,
            base: input.base,
            exitCode: add.exitCode,
            stderr: add.stderr.trim()
          })
        )
      }

      if (input.setup !== undefined) {
        const setup = yield* shell.run(["sh", "-c", input.setup], { cwd: runInfo.workRoot })
        if (setup.exitCode !== 0) {
          return yield* Effect.fail(
            new WorktreeSetupFailed({
              command: input.setup,
              exitCode: setup.exitCode,
              outputTail: tailOf(setup.stdout, setup.stderr)
            })
          )
        }
      }

      return { path: runInfo.workRoot }
    })
})
