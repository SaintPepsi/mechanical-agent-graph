import { Effect, Schema } from "effect"
import { PushDirty, PushEmpty, PushGitFailed, PushRejected } from "mag/graph-nodes/push-branch/errors"
import { make } from "mag/runtime/graph-node.definition"
import { gitReadRaw } from "mag/runtime/git"
import { dirtyPaths } from "mag/runtime/porcelain"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/**
 * Fails PushDirty if `git status --porcelain` reports any path. A non-zero exit is not read
 * as "clean by absence of output" — that would let a broken check pass silently, and unfit paths
 * should error rather than the system widening to swallow them — so it fails PushGitFailed instead.
 * The porcelain parse itself lives in `runtime/porcelain.ts`: `build` needs the same
 * read for a coarser question, so the line format has one home instead of two. The read itself is
 * `gitReadRaw`: `PushGitFailed`'s three fields are exactly
 * {@link GitFailureFields}'s, so the constructor callback is the migration's whole cost.
 */
const guardCleanTree = (cwd: string | undefined) =>
  Effect.gen(function* () {
    const status = yield* gitReadRaw(["git", "status", "--porcelain"], cwd, (fields) => new PushGitFailed(fields))
    const paths = dirtyPaths(status)
    if (paths.length > 0) {
      return yield* Effect.fail(new PushDirty({ paths }))
    }
  })

/**
 * Fails PushEmpty if `branch` has zero commits ahead of `base`. Argv order (`--count`
 * before the range) follows the codebase's own precedent for this exact command,
 * `build/graph-node.ts`'s baseline-commit count, rather than introduce a second argv shape for the
 * same subcommand. A non-zero exit or unparseable stdout (an unresolvable `base`, most likely) is
 * never silently read as 0 — it fails PushGitFailed, mirroring `build/graph-node.ts`'s own
 * `Number.isInteger` guard on the identical command.
 */
const guardBranchAhead = (cwd: string | undefined, branch: string, base: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const argv = ["git", "rev-list", "--count", `${base}..HEAD`] as const
    const result = yield* shell.run(argv, { cwd })
    const count = Number(result.stdout.trim())
    if (result.exitCode !== 0 || !Number.isInteger(count)) {
      return yield* Effect.fail(
        new PushGitFailed({ argv: argv.join(" "), exitCode: result.exitCode, stderr: result.stderr.trim() })
      )
    }
    if (count === 0) return yield* Effect.fail(new PushEmpty({ branch, base }))
  })

/**
 * `git push -u <remote> <branch>`. Always `-u` — on a branch with no upstream it sets tracking, so
 * a later bare `git push` or `git status` in that tree resolves an upstream on its own, and on a
 * branch that already tracks it is a no-op, so one form covers both cases. A refused push fails as {@link PushRejected} and the node stops there: retries,
 * exemptions and config edits stay outside this node entirely.
 *
 * Two mechanical, read-only preflights run first — a dirty tree or a branch with nothing
 * ahead of `base` both mean the push would publish something other than what the suite verified, so
 * both fail named rather than reaching `git push` at all. Neither guard stages, commits, or stashes
 * anything: the fix for a dirty tree is upstream, in `build` itself (the build node commits
 * mechanically what its agent session leaves uncommitted, rather than this node repairing
 * it). This guard's surviving job is dirt introduced after `build` returned — a review pass, a
 * manual edit — which is a genuinely different accident than the one `build`'s own commit step
 * closes.
 */
export const pushBranch = make({
  name: "push-branch",
  description: "Push the branch to the remote with upstream tracking set.",
  input: Schema.Struct({ remote: Schema.String, branch: Schema.String, base: Schema.String }),
  success: Schema.Struct({ remote: Schema.String, branch: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)

      yield* guardCleanTree(cwd)
      yield* guardBranchAhead(cwd, input.branch, input.base)

      const push = yield* shell.run(["git", "push", "-u", input.remote, input.branch], { cwd })

      if (push.exitCode !== 0) {
        return yield* Effect.fail(
          new PushRejected({
            remote: input.remote,
            branch: input.branch,
            exitCode: push.exitCode,
            stderr: push.stderr.trim()
          })
        )
      }

      return { remote: input.remote, branch: input.branch }
    })
})
