import { Effect, Schema } from "effect"
import { conflictPaths } from "mag/graph-nodes/detect-conflicts/conflict-paths"
import { ConflictProbeFailed, ConflictRefMissing } from "mag/graph-nodes/detect-conflicts/errors"
import { make } from "mag/runtime/graph-node.definition"
import { primaryDir, RunInfo } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/** `git rev-parse --verify -q refs/heads/<ref>`, the same exact-ref form `resolve-base` verifies with. */
const verifyRef = (cwd: string | undefined, ref: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const result = yield* shell.run(["git", "rev-parse", "--verify", "-q", `refs/heads/${ref}`], { cwd })
    if (result.exitCode !== 0) return yield* Effect.fail(new ConflictRefMissing({ ref }))
    return result.stdout.trim()
  })

/**
 * The mechanical half of the merge-conflict graph — probes whether `target` conflicts with `base`,
 * spends nothing, and never touches a working tree. `merge-tree` operates on the object database
 * alone, so this node needs no worktree, no checkout, and cannot be disturbed by a dirty one; it
 * also means the probe answers a question about the *odb*, while `fix-conflicts` answers one about
 * a *tree* — the two are different merges, which is why `fix-conflicts` re-measures the unmerged
 * set rather than trusting the list this node hands it.
 *
 * Both refs are verified first (`verifyRef`, `resolve-base`'s own exact-ref pattern, ref existence
 * shared across every worktree of a repository): `merge-tree`'s own exit 1 is ambiguous between
 * "conflicts" and "that ref is not something we can merge", so reading exit 1 before the refs are
 * known would report a typo'd branch name as a conflicting one, and no agent is dispatched on the
 * way to finding that out.
 *
 * Runs at `RunInfo.primaryDir`, never `workdir`: refs are shared across every worktree of a
 * repository, so the primary checkout is both the only available answer and the correct one
 * (`resolve-base`'s own precedent) — and it is what lets this node sit anywhere in a graph,
 * including ahead of `worktree-add`.
 *
 * `target` is passed first to `merge-tree` ("ours"), `base` second ("theirs"): `fix-conflicts` runs
 * `git merge <base>` on a checkout of `target`, so the probe and the fix describe the same merge
 * from the same side.
 */
export const detectConflicts = make({
  name: "detect-conflicts",
  description: "Probe whether target conflicts with base, mechanically, with no agent and no working tree.",
  input: Schema.Struct({ base: Schema.String, target: Schema.String }),
  success: Schema.Struct({
    base: Schema.String,
    target: Schema.String,
    baseSha: Schema.String,
    targetSha: Schema.String,
    conflicts: Schema.Array(Schema.String)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const runInfo = yield* RunInfo
      const cwd = primaryDir(runInfo)

      const targetSha = yield* verifyRef(cwd, input.target)
      const baseSha = yield* verifyRef(cwd, input.base)

      const argv = ["git", "merge-tree", "--write-tree", "--name-only", "-z", input.target, input.base] as const
      const probe = yield* shell.run(argv, { cwd })

      if (probe.exitCode === 0) {
        return { base: input.base, target: input.target, baseSha, targetSha, conflicts: [] }
      }

      if (probe.exitCode === 1) {
        const conflicts = conflictPaths(probe.stdout)
        if (conflicts.length > 0) {
          return { base: input.base, target: input.target, baseSha, targetSha, conflicts }
        }
      }

      return yield* Effect.fail(
        new ConflictProbeFailed({ argv: argv.join(" "), exitCode: probe.exitCode, stderr: probe.stderr.trim() })
      )
    })
})
