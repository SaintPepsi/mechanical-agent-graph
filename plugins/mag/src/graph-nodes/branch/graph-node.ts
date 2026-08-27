import { Effect, Schema } from "effect"
import { BranchCheckoutFailed, BranchCreateFailed } from "mag/graph-nodes/branch/errors"
import { make } from "mag/runtime/graph-node.definition"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/**
 * The resume-safe checkout: verify the ref first, check out an existing branch as-is, and reach
 * the branch-creating form only when the probe says the ref does not exist. A bare `checkout -B`
 * resets an existing branch onto the base and destroys its commits, and routing a *failed*
 * checkout into the creating form does the same thing one step later (a package manager once lost
 * commits by having a bad minute inside a post-checkout hook) — so the destructive path is
 * unreachable, not merely flagged, and a checkout that fails fails the node. The creating form is
 * `-b` rather than `-B`: under the guard the two are identical, and `-b` cannot reset a branch even
 * if the guard is ever wrong.
 *
 * The checkout happens at `RunInfo.workRoot` — where a run executes is declared, not defaulted:
 * every develop-graph run is isolated, so `workRoot` always names the worktree `worktree-add`
 * materialized ahead of this node.
 */
export const branch = make({
  name: "branch",
  description: "Check out the ticket's fix branch in the live checkout, resume-safe.",
  input: Schema.Struct({ branch: Schema.String, base: Schema.String }),
  success: Schema.Struct({ branch: Schema.String, created: Schema.Boolean }),
  run: (input) =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)

      const probe = yield* shell.run(["git", "rev-parse", "--verify", "-q", `refs/heads/${input.branch}`], { cwd })
      const exists = probe.exitCode === 0

      const checkout = exists
        ? yield* shell.run(["git", "checkout", input.branch], { cwd })
        : yield* shell.run(["git", "checkout", "-b", input.branch, input.base], { cwd })

      if (checkout.exitCode !== 0) {
        const detail = { branch: input.branch, exitCode: checkout.exitCode, stderr: checkout.stderr.trim() }
        return yield* Effect.fail(
          exists ? new BranchCheckoutFailed(detail) : new BranchCreateFailed({ ...detail, base: input.base })
        )
      }

      return { branch: input.branch, created: !exists }
    })
})
