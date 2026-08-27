/**
 * `design-under-review` mints no error of its own: its inferred `E` is exactly the union
 * `brainstorm.run`/`plan.run`/`reviewPlan.run` already produce, re-exported here,
 * `build-under-review/errors.ts`'s precedent. A cap-spent loop refails `PlanBlocked` itself,
 * findings still aboard; `PlanDisputeRejected` never routes back.
 */
export {
  BrainstormCommitFailed,
  BrainstormCopyFailed,
  BrainstormGitFailed,
  BrainstormResumeEmpty,
  DesignMissing
} from "mag/graph-nodes/brainstorm/errors"
export { PlanCommitFailed, PlanCopyFailed, PlanGitFailed, PlanMissing } from "mag/graph-nodes/plan/errors"
export {
  PlanBlocked,
  PlanDisputeIncomplete,
  PlanDisputeRejected,
  PlanFindingsWriteFailed,
  PlanReviewGitFailed,
  PlanReviewRunRootMissing
} from "mag/graph-nodes/review-plan/errors"
