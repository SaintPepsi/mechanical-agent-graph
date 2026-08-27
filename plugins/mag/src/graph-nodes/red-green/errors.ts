import { Data } from "effect"

/**
 * The verdicts this loop mints. `assert-red` emits paths, never a routing decision, so the tag
 * that names what its buckets mean is the composite's own: each is routed back while the cap
 * allows, and refailed with the last pass's evidence once it is spent.
 */

/** The red commit does not typecheck: `write-red` owes tests that compile against its own stubs, and did not deliver. `reportPath` holds the command's output. */
export class RedTestsDoNotCompile extends Data.TaggedError("RED_TESTS_DO_NOT_COMPILE")<{
  readonly command: string
  readonly exitCode: number
  readonly reportPath: string
  readonly redSha: string
}> {}

/** A planned test was green the moment it was written: it asserts nothing the current code gets wrong. */
export class DeadTestAtBirth extends Data.TaggedError("DEAD_TEST_AT_BIRTH")<{
  readonly green: readonly string[]
  readonly redSha: string
}> {}

/** After the implementation pass, a test is still red: the work is not done. */
export class StillRed extends Data.TaggedError("STILL_RED")<{
  readonly red: readonly string[]
  readonly sha: string
}> {}

/** The typecheck report lands in the run root; a node reached with none is a wiring bug (`build/errors.ts`'s `BuildRunRootMissing`). */
export class RedGreenRunRootMissing extends Data.TaggedError("RED_GREEN_RUN_ROOT_MISSING")<{}> {}

/** `writeArtifact`'s own `PlatformError` on the typecheck report, caught and named. */
export class RedGreenReportWriteFailed extends Data.TaggedError("RED_GREEN_REPORT_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
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
