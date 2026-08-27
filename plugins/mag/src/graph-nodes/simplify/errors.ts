import { Data } from "effect"

/**
 * A live simplify run needs a run directory (`RunInfo.runRoot`) to be wired up — same reasoning and
 * precedent as `build/errors.ts`'s `BuildRunRootMissing`, `design/errors.ts`'s `DesignRunRootMissing`
 * and `review-diff/errors.ts`'s `ReviewRunRootMissing`: a node reached outside `runScopedLayers` is a
 * wiring bug, not something a write-then-fail-later path should paper over.
 */
export class SimplifyRunRootMissing extends Data.TaggedError("SIMPLIFY_RUN_ROOT_MISSING")<{}> {}

/**
 * The checkout's `HEAD` is not the sha the caller declared it was gating, checked before any other
 * read and before any dispatch so a moved tree burns no session — `review-diff/errors.ts`'s
 * `ReviewHeadMoved` precedent, reused here because the two nodes make the same claim about the same
 * fact.
 */
export class SimplifyHeadMoved extends Data.TaggedError("SIMPLIFY_HEAD_MOVED")<{
  readonly expected: string
  readonly observed: string
}> {}

/**
 * One of the node's own git reads (the head gate, the changed-paths probe, the dirty-tree gate, the
 * post-commit sha) failed non-zero — without them this node cannot answer its own question, so it
 * stops rather than guessing. `runtime/git.ts`'s `gitRead` and `commitAgentLeftovers` both fail this
 * tag through their caller-supplied constructor; `build/errors.ts`'s `BuildGitFailed` precedent.
 */
export class SimplifyGitFailed extends Data.TaggedError("SIMPLIFY_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * The tree was already dirty before any dispatch — `git add -A` cannot tell this session's edits from
 * dirt that predates it, and a commit claiming to be the subtraction pass must contain only the
 * subtraction pass. `build/errors.ts`'s `BuildWorkdirDirty` precedent, `push-branch`'s
 * `guardCleanTree` the mechanism both nodes share.
 */
export class SimplifyWorkdirDirty extends Data.TaggedError("SIMPLIFY_WORKDIR_DIRTY")<{
  readonly paths: readonly string[]
}> {}

/**
 * The node's own mechanical commit (`git add -A` or `git commit -m`) exited non-zero after the
 * pre-dispatch gate found the tree clean and the session then dirtied it. A failed *write*, not a
 * failed measurement: the reduction is still sitting in the tree, salvageable by hand.
 * `build/errors.ts`'s `BuildCommitFailed` precedent — same fields, `sessions` included because the
 * agent spend already happened by this point.
 */
export class SimplifyCommitFailed extends Data.TaggedError("SIMPLIFY_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}
