import { Data } from "effect"
import type { RatedEscape } from "mag/runtime/suite-escape"

/** The summary artifact lands in the run root; a node reached with none is a wiring bug (`build/errors.ts`'s `BuildRunRootMissing`). */
export class TddBuildRunRootMissing extends Data.TaggedError("TDD_BUILD_RUN_ROOT_MISSING")<{}> {}

/** One of the composite's own git reads (the starting head, the changed-paths read, the commit count) failed. */
export class TddBuildGitFailed extends Data.TaggedError("TDD_BUILD_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** `writeArtifact`'s own `PlatformError` on the summary, caught and named. */
export class TddBuildSummaryWriteFailed extends Data.TaggedError("TDD_BUILD_SUMMARY_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}

/**
 * The review lane still found a severity-2-or-worse escape after the last round the cap allowed.
 * The gate is "no severe escape within budget", never "unbreakable" (nothing is), so the loop
 * ends on the escape it could not close, carried for the ledger and for a human.
 */
export class TddBuildEscapeUnresolved extends Data.TaggedError("TDD_BUILD_ESCAPE_UNRESOLVED")<{
  readonly escape: RatedEscape
  readonly rounds: number
  readonly headSha: string
}> {}

/** The rest of this composite's union is exactly what its parts already produce, re-exported. */
export {
  BreakNoSources,
  DetectJsTestsNoPaths,
  SeverityEscapesWriteFailed,
  SeverityRatingsIncomplete,
  SeverityRunRootMissing,
  TestSmellsUnreadable,
  VerifyEscapesMutationFailed,
  VerifyEscapesProbeWriteFailed,
  VerifyEscapesRestoreFailed,
  VerifyEscapesRunRootMissing,
  VerifyEscapesSuiteRed
} from "mag/graph-nodes/adversarial-review/errors"
export {
  AssertRedGitFailed,
  AssertRedHeadMoved,
  AssertRedNoTests,
  DeadTestAtBirth,
  RedGreenReportWriteFailed,
  RedGreenRunRootMissing,
  RedTestsDoNotCompile,
  ImplementCommitFailed,
  ImplementDisputeWriteFailed,
  ImplementGitFailed,
  ImplementHeadMoved,
  ImplementNoCommits,
  ImplementResumeEmpty,
  ImplementRunRootMissing,
  ImplementWorkdirDirty,
  PathsTouched,
  PathsUntouchedGitFailed,
  StillRed,
  TestDisputed,
  WriteRedCommitFailed,
  WriteRedGitFailed,
  WriteRedHeadMoved,
  WriteRedNoTests,
  WriteRedPathsMissing,
  WriteRedPathsUndeclared,
  WriteRedWorkdirDirty
} from "mag/graph-nodes/red-green/errors"
export { TestPlanAcsEmpty } from "mag/graph-nodes/test-plan/errors"
export {
  VerificationFailed,
  VerificationReportWriteFailed,
  VerificationRunRootMissing
} from "mag/graph-nodes/verification/errors"
