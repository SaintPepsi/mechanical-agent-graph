import { Data } from "effect"

/**
 * The agent came back green with zero forward commits and `HEAD` exactly where this pass found it
 * (a zero count with `HEAD` moved instead is {@link BuildHeadMoved}, not this). Covers two
 * conditions: a first pass that did nothing (no `findingsPath`), and a send-back pass met with
 * silence — no `dispute` in the reply, or one that trims to nothing. Either way there is no work to
 * verify and nothing for a person to review. `commits` carries the count the node measured (zero
 * today, but the field states what was counted rather than assuming it).
 */
export class BuildNoCommits extends Data.TaggedError("BUILD_NO_COMMITS")<{
  readonly commits: number
}> {}

/**
 * A pass counted zero forward commits from `before` but `HEAD` moved anyway, caught by
 * `graph-node.ts`'s head gate: `git rev-list --count before..HEAD === 0` means `HEAD` is not
 * *ahead* of `before`, not that `HEAD` *is* `before` — a session that ran `git reset --hard HEAD~1`
 * or checked out a different ref leaves zero forward commits while the tree the previous pass
 * verified is gone. Distinct from {@link BuildNoCommits} because the operational response is the
 * opposite one: that tag means the agent did nothing to a tree that is still there, this one means
 * the branch lost commits and the previously-verified tree no longer exists. Named and shaped after
 * `review-diff/errors.ts`'s `ReviewHeadMoved` — the same fact, caught at a different node.
 */
export class BuildHeadMoved extends Data.TaggedError("BUILD_HEAD_MOVED")<{
  readonly expected: string
  readonly observed: string
}> {}

/**
 * One of the node's own git calls (the pre-agent baseline, the pre-agent dirty-tree probe, the
 * leftover-commit probe, the post-agent count) failed — without them "did the agent commit
 * anything" has no answer, so the node stops rather than guessing.
 */
export class BuildGitFailed extends Data.TaggedError("BUILD_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * The pre-agent probe (`git status --porcelain`, run alongside the baseline `rev-parse`, before any
 * agent spend) found the working tree already dirty. `add -A` cannot tell the run's own leftovers
 * from dirt that was sitting there first, so a dirty tree at this point is refused outright rather
 * than being folded into the salvage commit's attribution — the failure mode this avoids is an
 * unrelated untracked file landing in a commit that claims to be the ticket's work. `paths` names
 * what was found, same shape as `push-branch`'s `PushDirty`.
 */
export class BuildWorkdirDirty extends Data.TaggedError("BUILD_WORKDIR_DIRTY")<{
  readonly paths: readonly string[]
}> {}

/**
 * The node's own mechanical salvage — `git add -A` or `git commit -m` — exited non-zero after the
 * probe found a dirty tree. A failed *write*, not a failed measurement: the work is still sitting
 * in the tree exactly as it was, salvageable by hand, which is the opposite operational response to
 * `BuildGitFailed`. Carries `stderr` so a refusing hook or a missing git identity (`fatal: empty
 * ident name`) arrives as itself, and `stdout` alongside it — a `commit` on an empty index writes
 * its "nothing to commit, working tree clean" explanation to stdout, not stderr, and without it that
 * class of failure arrives with no diagnostic at all. `sessions` rides along because the agent spend
 * already happened, matching `BuildSummaryEmpty`'s precedent.
 */
export class BuildCommitFailed extends Data.TaggedError("BUILD_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

/**
 * A live build run needs a run directory to write its summary artifact into. `RunInfo`'s default
 * `runRoot` is `""` for exactly the case where none was ever wired up — a build node reached
 * outside `runScopedLayers`. That is a wiring bug, not a data problem: unfit paths error rather than
 * being worked around (repo `CLAUDE.md`), so this fails before any agent spend, same as
 * `design/errors.ts`'s `DesignRunRootMissing`.
 */
export class BuildRunRootMissing extends Data.TaggedError("BUILD_RUN_ROOT_MISSING")<{}> {}

/**
 * The agent's structured verdict held a blank summary. Nothing downstream (the branch, the
 * commits) is wrong, but there is no document worth an artifact — `sessions` rides along because
 * the spend already happened by this point.
 */
export class BuildSummaryEmpty extends Data.TaggedError("BUILD_SUMMARY_EMPTY")<{
  readonly sessions: readonly string[]
}> {}

/**
 * `writeArtifact`'s own `PlatformError`, caught and named — same as `design/errors.ts`'s
 * `DesignCopyFailed`, a platform error caught and named rather than left raw so a node's inferred
 * error union stays domain tags only. Also raised when the dispute artifact fails to write: it is
 * the same failure mode, "this node could not record what a pass produced," under a different prefix.
 */
export class BuildSummaryWriteFailed extends Data.TaggedError("BUILD_SUMMARY_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}

/**
 * A send-back pass that answered the previous review's findings instead of actioning them: a clean
 * tree, no new commit, and an argument on disk. Distinct from {@link BuildNoCommits}
 * by the gate at `graph-node.ts`'s count branch — `input.findingsPath` present (this is a send-back
 * pass) and `reply.verdict.dispute` present (the pass said why) is the only way here; silence on
 * either one is still `BuildNoCommits`. Routed by `build-under-review` rather than escalated, so it
 * carries the pass's price for the composite to fold in, and the two paths a human — or the
 * adjudicating review pass — needs to read both sides of the disagreement.
 */
export class BuildDisputed extends Data.TaggedError("BUILD_DISPUTED")<{
  readonly summaryPath: string
  readonly disputePath: string
  readonly findingsPath: string
  readonly headSha: string
  readonly commits: number
  readonly sessions: readonly string[]
  readonly costUsd: number | null
}> {}

/**
 * `resume` was set with neither `findingsPath` nor `addendum` to carry, a resumed session would be
 * dispatched with no instruction at all, an empty prompt bought at full session price. Not a guard
 * against a failure this node has never seen: the combination is expressible from the CLI today,
 * `resume` being its own flag, so it is checked rather than left to spend a session on silence.
 */
export class BuildResumeEmpty extends Data.TaggedError("BUILD_RESUME_EMPTY")<{}> {}
