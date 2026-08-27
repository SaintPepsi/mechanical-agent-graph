import { Data } from "effect"

/**
 * The checkout's `HEAD` is not the sha the caller said it was classifying, checked before any test
 * command runs: a verdict about the wrong tree is worse than no verdict. `review-diff/errors.ts`'s
 * `ReviewHeadMoved` precedent.
 */
export class AssertRedHeadMoved extends Data.TaggedError("ASSERT_RED_HEAD_MOVED")<{
  readonly expected: string
  readonly observed: string
}> {}

/** The head gate's own `git rev-parse` failed, so the node cannot say which tree it is about. */
export class AssertRedGitFailed extends Data.TaggedError("ASSERT_RED_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** An empty test list is an unfit input: a classification of nothing is not a verdict a loop can route on. */
export class AssertRedNoTests extends Data.TaggedError("ASSERT_RED_NO_TESTS")<{}> {}
