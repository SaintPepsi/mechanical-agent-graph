import { Data } from "effect"

/**
 * The three verdicts this loop mints from `assert-red`'s buckets. `assert-red` emits paths, never
 * a routing decision, so the tag that names what the buckets mean is the composite's own: each is
 * routed back while the cap allows, and refailed with the last pass's evidence once it is spent.
 */

/** A planned test was green the moment it was written: it asserts nothing the current code gets wrong. */
export class DeadTestAtBirth extends Data.TaggedError("DEAD_TEST_AT_BIRTH")<{
  readonly green: readonly string[]
  readonly redSha: string
}> {}

/** A test never ran at all (a compile error, a missing import): red for the wrong reason, so not a spec. */
export class HarnessError extends Data.TaggedError("HARNESS_ERROR")<{
  readonly broken: readonly string[]
  readonly sha: string
}> {}

/** After the implementation pass, a test is still red or broken: the work is not done. */
export class StillRed extends Data.TaggedError("STILL_RED")<{
  readonly red: readonly string[]
  readonly broken: readonly string[]
  readonly sha: string
}> {}

/** The rest of this composite's union is exactly what its parts already produce, re-exported. */
export { AssertRedGitFailed, AssertRedHeadMoved, AssertRedNoTests } from "mag/graph-nodes/assert-red/errors"
export {
  ImplementCommitFailed,
  ImplementDisputeWriteFailed,
  ImplementGitFailed,
  ImplementHeadMoved,
  ImplementNoCommits,
  ImplementResumeEmpty,
  ImplementRunRootMissing,
  ImplementWorkdirDirty,
  TestDisputed
} from "mag/graph-nodes/implement/errors"
export { PathsTouched, PathsUntouchedGitFailed } from "mag/graph-nodes/paths-untouched/errors"
export {
  WriteRedCommitFailed,
  WriteRedGitFailed,
  WriteRedHeadMoved,
  WriteRedNoTests,
  WriteRedPathsMissing,
  WriteRedPathsUndeclared,
  WriteRedWorkdirDirty
} from "mag/graph-nodes/write-red/errors"
