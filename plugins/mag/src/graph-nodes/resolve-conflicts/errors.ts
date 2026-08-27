/**
 * `resolve-conflicts` mints no error of its own: its inferred `E` is exactly
 * the union `detectConflicts.run`/`fixConflicts.run`/`verification.run` already produce, so these
 * are re-exports, not new classes — the `publish`/`build-under-review` precedent.
 */
export { ConflictProbeFailed, ConflictRefMissing } from "mag/graph-nodes/detect-conflicts/errors"
export {
  FixCommitFailed,
  FixConflictMarkersLeft,
  FixConflictsUnresolved,
  FixGitFailed,
  FixMergeStartFailed,
  FixMergeWithoutConflict,
  FixRunRootMissing,
  FixSummaryEmpty,
  FixSummaryWriteFailed,
  FixWorkdirDirty
} from "mag/graph-nodes/fix-conflicts/errors"
export {
  VerificationFailed,
  VerificationReportWriteFailed,
  VerificationRunRootMissing
} from "mag/graph-nodes/verification/errors"
