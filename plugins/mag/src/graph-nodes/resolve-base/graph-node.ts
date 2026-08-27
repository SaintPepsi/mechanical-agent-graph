import { Effect, Schema } from "effect"
import { BaseRefMissing, BaseRemoteMissing, BaseRemoteUnavailable } from "mag/graph-nodes/resolve-base/errors"
import { make } from "mag/runtime/graph-node.definition"
import { primaryDir, RunInfo } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/**
 * Verify the run's base branch exists in this checkout and on the remote, before `design`
 * or any other node spends. `branch`, `review-diff` and `push-branch` all assume a resolvable
 * `base` and only fail on it incidentally, late, or (for a pre-created stacked branch) not at all.
 * This node exists so a bad base dies at position zero of the pipeline instead.
 *
 * Local first, remote second, and the local probe's exit code is read as-is, never as "0 means
 * found" plus an assumed failure mode for everything else — an unfit input should error rather
 * than the system widening around it, and that applies to this node's own two shell calls too.
 * Exit codes probed directly: `git rev-parse --verify -q` is 0 found, 1 not
 * found; `git ls-remote --exit-code --heads` is 0 found, 2 no such branch, anything else
 * unreachable — so `2` alone becomes {@link BaseRemoteMissing} and every other non-zero becomes
 * {@link BaseRemoteUnavailable}, keeping an offline machine from being reported as a bad base.
 *
 * Runs at `RunInfo.primaryDir`, never `workdir`, and that is a decision, not an omission —
 * this node runs before `worktree-add` creates the worktree, and refs are shared across every
 * worktree of a repository anyway, so the primary checkout is both the only available answer and
 * the correct one. Staying at position zero is load-bearing for worktree hygiene, not just for
 * spend: a base that doesn't resolve dies before any worktree exists, so a refused run leaves
 * nothing to clean up.
 */
export const resolveBase = make({
  name: "resolve-base",
  description: "Verify the run's base branch exists in this checkout and on the remote.",
  input: Schema.Struct({ base: Schema.String, remote: Schema.String }),
  success: Schema.Struct({ base: Schema.String, sha: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const runInfo = yield* RunInfo
      const cwd = primaryDir(runInfo)

      const local = yield* shell.run(["git", "rev-parse", "--verify", "-q", `refs/heads/${input.base}`], { cwd })
      if (local.exitCode !== 0) return yield* Effect.fail(new BaseRefMissing({ base: input.base }))

      // Full ref, not the bare name: `ls-remote`'s pattern tail-matches ref components, so a bare
      // `main` happily matches `refs/heads/release/main` and a never-pushed stacked parent can
      // slip past on a name collision. `refs/heads/<base>` makes
      // the probe an exact existence check, the same form the local probe uses.
      const remote = yield* shell.run(
        ["git", "ls-remote", "--exit-code", "--heads", input.remote, `refs/heads/${input.base}`],
        { cwd }
      )
      if (remote.exitCode === 2) {
        return yield* Effect.fail(new BaseRemoteMissing({ base: input.base, remote: input.remote }))
      }
      if (remote.exitCode !== 0) {
        return yield* Effect.fail(
          new BaseRemoteUnavailable({ remote: input.remote, exitCode: remote.exitCode, stderr: remote.stderr.trim() })
        )
      }

      return { base: input.base, sha: local.stdout.trim() }
    })
})
