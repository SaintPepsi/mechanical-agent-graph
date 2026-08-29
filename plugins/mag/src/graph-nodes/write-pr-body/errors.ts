import { Data } from "effect"

/**
 * A live run needs a run directory to write its own diff artifact into. Same reasoning
 * and precedent as `review-diff/errors.ts`'s `ReviewRunRootMissing`: a node reached outside
 * `runScopedLayers` is a wiring bug, not something a write-then-fail-later path should paper over.
 */
export class PrBodyRunRootMissing extends Data.TaggedError("PR_BODY_RUN_ROOT_MISSING")<{}> {}

/** One of this node's own git reads exited non-zero: the `HEAD` read or the merge-base diff itself. */
export class PrBodyGitFailed extends Data.TaggedError("PR_BODY_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * `writeArtifact`'s own `PlatformError` on the diff write, caught and named — `ReviewDiffWriteFailed`'s
 * precedent, one call earlier than any dispatch, so an unwritable run root costs nothing spent.
 */
export class PrBodyDiffWriteFailed extends Data.TaggedError("PR_BODY_DIFF_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}

/** `writeArtifact`'s `PlatformError` on the description write, after a real session already produced it: `sessions` travels with it because the spend already happened. */
export class PrBodyDescriptionWriteFailed extends Data.TaggedError("PR_BODY_DESCRIPTION_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}
