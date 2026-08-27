import { Data } from "effect"

/**
 * A `tdd` first pass was asked for without the recon note the planner reads or the per-path test
 * command `assert-red` classifies with. The two fields stay independently optional on the input
 * (a flat struct of primitives is what the CLI derives flags from, `review-diff`'s
 * `findingsPath`/`disputePath` reasoning), so `run` checks them together, first, before any read.
 */
export class BuildTddInputsMissing extends Data.TaggedError("BUILD_TDD_INPUTS_MISSING")<{
  readonly discoverPath: string | undefined
  readonly testCommand: string | undefined
}> {}

/**
 * Beyond {@link BuildTddInputsMissing}, `build-under-review` mints no error of its own: its inferred
 * `E` is exactly the union `build.run`/`tddBuild.run`/`simplify.run`/`verification.run`/
 * `reviewDiff.run` already produce, so these are
 * re-exports, not new classes, with one deliberate exception. `BuildDisputed` is missing: the
 * dispute edge (`graph-node.ts`'s loop, the `failure._tag !== "BUILD_DISPUTED"` branch) catches
 * that tag itself and turns it into either a success (the adjudicating `reviewDiff` pass accepts
 * the dispute) or a `reviewDiff` failure (`ReviewDisputeRejected` when it doesn't), so
 * `BUILD_DISPUTED` never reaches this node's own inferred `E` the way the rest of `build`'s union
 * does. A cap-spent loop still refails `ReviewBlocked` itself, findings still aboard. `simplify`'s
 * five tags are re-exported the same way, along with `BuildResumeEmpty`,
 * `VerificationReportWriteFailed` and `VerificationRunRootMissing`.
 */
export {
  BuildCommitFailed,
  BuildGitFailed,
  BuildHeadMoved,
  BuildNoCommits,
  BuildResumeEmpty,
  BuildRunRootMissing,
  BuildSummaryEmpty,
  BuildSummaryWriteFailed,
  BuildWorkdirDirty
} from "mag/graph-nodes/build/errors"
export {
  SimplifyCommitFailed,
  SimplifyGitFailed,
  SimplifyHeadMoved,
  SimplifyRunRootMissing,
  SimplifyWorkdirDirty
} from "mag/graph-nodes/simplify/errors"
export {
  VerificationFailed,
  VerificationReportWriteFailed,
  VerificationRunRootMissing
} from "mag/graph-nodes/verification/errors"
export {
  ReviewBlocked,
  ReviewDiffWriteFailed,
  ReviewDisputeIncomplete,
  ReviewDisputeRejected,
  ReviewFindingsWriteFailed,
  ReviewGitFailed,
  ReviewHeadMoved,
  ReviewRunRootMissing
} from "mag/graph-nodes/review-diff/errors"
/** The `tdd` first pass's own union, `tdd-build/errors.ts`'s re-exports carried one level up. */
export {
  AssertRedGitFailed,
  AssertRedHeadMoved,
  AssertRedNoTests,
  BreakNoSources,
  DeadTestAtBirth,
  DetectJsTestsNoPaths,
  HarnessError,
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
  SeverityEscapesWriteFailed,
  SeverityRatingsIncomplete,
  SeverityRunRootMissing,
  StillRed,
  TddBuildEscapeUnresolved,
  TddBuildGitFailed,
  TddBuildRunRootMissing,
  TddBuildSummaryWriteFailed,
  TestDisputed,
  TestPlanAcsEmpty,
  TestSmellsUnreadable,
  VerifyEscapesMutationFailed,
  VerifyEscapesProbeWriteFailed,
  VerifyEscapesRestoreFailed,
  VerifyEscapesRunRootMissing,
  VerifyEscapesSuiteRed,
  WriteRedCommitFailed,
  WriteRedGitFailed,
  WriteRedHeadMoved,
  WriteRedNoTests,
  WriteRedPathsMissing,
  WriteRedPathsUndeclared,
  WriteRedWorkdirDirty
} from "mag/graph-nodes/tdd-build/errors"
