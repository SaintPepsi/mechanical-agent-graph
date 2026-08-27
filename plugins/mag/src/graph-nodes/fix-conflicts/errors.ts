import { Data } from "effect"

/**
 * `git status --porcelain` found the tree already dirty before the merge starts — before any agent
 * spend, `build`'s `BuildWorkdirDirty` precedent. `paths` names what was found.
 */
export class FixWorkdirDirty extends Data.TaggedError("FIX_WORKDIR_DIRTY")<{
  readonly paths: readonly string[]
}> {}

/**
 * `git merge --no-commit --no-ff <base>` failed for a reason that is neither a clean merge (exit 0)
 * nor a conflict (exit 1) — probed against git 2.53.0: a genuine conflict exits 1 with an unmerged
 * index, so anything else (128 on unrelated histories, or any other exit) is a merge that never
 * started the way this node needs it to.
 */
export class FixMergeStartFailed extends Data.TaggedError("FIX_MERGE_START_FAILED")<{
  readonly base: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * `git merge --no-commit --no-ff <base>` exited 0 — the tree merged cleanly, contradicting the
 * `detect-conflicts` verdict that dispatched this node. Not a silent success: the tree this node
 * was told to fix had nothing wrong with it, which means the two nodes disagree about the same
 * merge, and that disagreement is the thing to report.
 */
export class FixMergeWithoutConflict extends Data.TaggedError("FIX_MERGE_WITHOUT_CONFLICT")<{
  readonly base: string
  readonly target: string
}> {}

/**
 * After the resolver session, `git diff --name-only --diff-filter=U` still names unmerged entries.
 * `paths` carries what remains — the resolver's reply is a map, this is a read of the territory.
 */
export class FixConflictsUnresolved extends Data.TaggedError("FIX_CONFLICTS_UNRESOLVED")<{
  readonly paths: readonly string[]
}> {}

/**
 * `git diff --cached --check`, run after this node's own `git add -A`, named at least one
 * `leftover conflict marker` line (probed, git 2.53.0) in the tree about to be committed. Git's own
 * leftover-marker detector, so a file whose markers were staged rather than resolved cannot pass as
 * done. `detail` carries only the marker lines: `--check` also flags whitespace violations under
 * `core.whitespace`'s defaults, unrelated to a resolved conflict and probed to trip on a target
 * repo's pre-existing habits alone, so those lines never reach this tag.
 */
export class FixConflictMarkersLeft extends Data.TaggedError("FIX_CONFLICT_MARKERS_LEFT")<{
  readonly detail: string
}> {}

/** The resolver's structured reply held a blank summary. The spend already happened; `sessions` rides along. */
export class FixSummaryEmpty extends Data.TaggedError("FIX_SUMMARY_EMPTY")<{
  readonly sessions: readonly string[]
}> {}

/** `writeArtifact` failed to write the resolver's summary — `PlatformError`, caught and named so the domain error union stays closed. */
export class FixSummaryWriteFailed extends Data.TaggedError("FIX_SUMMARY_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}

/**
 * One of this domain's own finishing git writes failed: `git add -A`, staged by this node's own
 * `run`, or `git commit` itself, run by {@link commitMerge} once `resolve-conflicts` has verified
 * the staged tree. Both are "the fix could not be finished" failures with the same shape, so they
 * share one tag regardless of which call made it — `argv` says which.
 */
export class FixCommitFailed extends Data.TaggedError("FIX_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly sessions: readonly string[]
}> {}

/**
 * A git call this node depends on to answer its own question exited non-zero for a reason that
 * isn't one of the domain outcomes above: the pre-merge dirty probe, either unmerged-set read,
 * `write-tree` computing the staged tree's identity, or `commitMerge`'s own `rev-parse HEAD`. Never
 * read as a negative answer: a `status` that fails is not "clean".
 */
export class FixGitFailed extends Data.TaggedError("FIX_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * A live run needs a run directory to write the resolver's summary artifact into, the same
 * requirement `build` has. `RunInfo`'s default `runRoot` is `""` for exactly the case this node was
 * reached outside `runScopedLayers` — invoked directly, with no worktree wired up either, which
 * would otherwise run a real `git merge` against the maintainer's primary checkout. A wiring bug,
 * not a data problem: this fails before the merge starts, `build/errors.ts`'s `BuildRunRootMissing`
 * precedent.
 */
export class FixRunRootMissing extends Data.TaggedError("FIX_RUN_ROOT_MISSING")<{}> {}
