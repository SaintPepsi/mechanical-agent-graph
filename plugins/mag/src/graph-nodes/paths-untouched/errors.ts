import { Data } from "effect"

/**
 * The range touched a path it was forbidden to touch. This is the mechanical form of "never
 * loosen an assertion": an implementation pass that edited a test file cannot claim the test
 * still gates it. `paths` names exactly the forbidden paths the diff reached, so the caller can
 * say which tests were tampered with rather than only that some were.
 */
export class PathsTouched extends Data.TaggedError("PATHS_TOUCHED")<{
  readonly paths: readonly string[]
  readonly fromSha: string
  readonly toSha: string
}> {}

/** The node's one git read failed, so it cannot answer its own question and stops rather than guessing. */
export class PathsUntouchedGitFailed extends Data.TaggedError("PATHS_UNTOUCHED_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}
