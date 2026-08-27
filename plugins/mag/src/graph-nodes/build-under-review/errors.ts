/**
 * `build-under-review` mints no error of its own: its inferred `E` is exactly the union
 * `build.run`/`simplify.run`/`verification.run`/`reviewDiff.run` already produce, so these are
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
