import { Data } from "effect"

/**
 * The review found problems that must be fixed before the diff can merge. This is the error
 * `build-under-review` classifies as blocking: the findings feed back into the producer, and when the
 * loop's cap is spent this same error — the findings path intact — is the loop's failure.
 *
 * `sessions` and `costUsd` ride on the error because a blocked pass still spent agent money and
 * the journal records an error row's tag only — the graph that catches this is the one place the
 * pass's price can still be accounted (the journal deliberately has no cost column).
 *
 * `findingsPath` replaces the raw `findings` array: the findings are a
 * run-root artifact, one per pass, so a blocked pass's document survives in the run record instead
 * of only inside this error value.
 *
 * `headSha` names the tree the verdict was derived from: a blocked pass still names
 * its own tree, the same way a clean one does, so a consumer can tell which commit a blocking
 * finding is about without opening the artifact.
 */
export class ReviewBlocked extends Data.TaggedError("REVIEW_BLOCKED")<{
  readonly findingsPath: string
  readonly headSha: string
  readonly sessions: readonly string[]
  readonly costUsd: number | null
}> {}

/** A git read this node depends on could not be produced: the diff, or either read behind `governingPrinciples`. */
export class ReviewGitFailed extends Data.TaggedError("REVIEW_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * The tree this node is standing in is not the tree the caller declared it was gating:
 * the checkout's `HEAD` disagrees with `input.headSha`, read and compared before any other
 * read and before any dispatch, so a moved tree burns no session. Named after what happened, not
 * after which read caught it — "the review's head moved" is the same fact whether the caller passed
 * a stale sha or something outside the run rewrote the checkout in between.
 */
export class ReviewHeadMoved extends Data.TaggedError("REVIEW_HEAD_MOVED")<{
  readonly expected: string
  readonly observed: string
}> {}

/**
 * A live review run needs a run directory to write its findings artifact into. Same
 * reasoning and precedent as `build/errors.ts`'s `BuildRunRootMissing` and `design/errors.ts`'s
 * `DesignRunRootMissing`: a node reached outside `runScopedLayers` is a wiring bug, not something a
 * write-then-fail-later path should paper over.
 */
export class ReviewRunRootMissing extends Data.TaggedError("REVIEW_RUN_ROOT_MISSING")<{}> {}

/**
 * `writeArtifact`'s own `PlatformError`, caught and named — same precedent as
 * `build/errors.ts`'s `BuildSummaryWriteFailed`.
 */
export class ReviewFindingsWriteFailed extends Data.TaggedError("REVIEW_FINDINGS_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}

/**
 * `writeArtifact`'s own `PlatformError` on the diff write, caught and named — the same
 * precedent as `ReviewFindingsWriteFailed` above, one call earlier. It carries no `sessions` field
 * because nothing has been dispatched yet when this write happens: unlike a findings-write failure,
 * this one costs zero.
 */
export class ReviewDiffWriteFailed extends Data.TaggedError("REVIEW_DIFF_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}

/** Raised by an adjudicating pass that still blocks; whether that ends the run or routes back to `build` depends on whether the caller's tree had moved, which only the composite (`sendsBack`) knows. */
export class ReviewDisputeRejected extends Data.TaggedError("REVIEW_DISPUTE_REJECTED")<{
  readonly findingsPath: string
  readonly disputePath: string
  readonly headSha: string
  readonly sessions: readonly string[]
  readonly costUsd: number | null
}> {}

/**
 * `findingsPath` and `disputePath` arrived with exactly one of the pair set:
 * the schema keeps them as two independently-optional fields because
 * this node's input has to stay a flat struct of primitives for `deriveFlagSpecs`
 * (`runtime/schema-flags.ts`) to walk into CLI flags: a nested `dispute` struct field holding the
 * pair fails that walk with `UNSUPPORTED_INPUT_SCHEMA`. `run`
 * checks the pair together, first, before any other read: a caller can only produce a half-set
 * shape by hand-assembling a malformed input, since `build-under-review` always passes both or
 * neither, so this fails loudly rather than silently choosing which side to believe.
 */
export class ReviewDisputeIncomplete extends Data.TaggedError("REVIEW_DISPUTE_INCOMPLETE")<{
  readonly findingsPath: string | undefined
  readonly disputePath: string | undefined
}> {}
