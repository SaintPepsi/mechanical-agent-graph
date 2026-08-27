import { Data } from "effect"

/**
 * The review found defects in the design or the plan that must be settled before any build. The
 * error `design-under-review` classifies as blocking: the findings feed back into `brainstorm`,
 * and when the loop's cap is spent this same error — the findings path intact — is the loop's
 * failure. `sessions` and `costUsd` ride on it because a blocked pass still spent agent money
 * and the journal records an error row's tag only (`review-diff/errors.ts`'s `ReviewBlocked`).
 */
export class PlanBlocked extends Data.TaggedError("PLAN_BLOCKED")<{
  readonly findingsPath: string
  readonly headSha: string
  readonly sessions: readonly string[]
  readonly costUsd: number | null
}> {}

/** Raised by an adjudicating pass that still blocks: the design's dispute did not settle the findings, and the run ends rather than routing back. */
export class PlanDisputeRejected extends Data.TaggedError("PLAN_DISPUTE_REJECTED")<{
  readonly findingsPath: string
  readonly disputePath: string
  readonly headSha: string
  readonly sessions: readonly string[]
  readonly costUsd: number | null
}> {}

/** `findingsPath` and `disputePath` arrived with exactly one of the pair set — `review-diff`'s `ReviewDisputeIncomplete`, same reasoning: the input stays a flat struct so `schema-flags.ts` can walk it, and `run` checks the pair first. */
export class PlanDisputeIncomplete extends Data.TaggedError("PLAN_DISPUTE_INCOMPLETE")<{
  readonly findingsPath: string | undefined
  readonly disputePath: string | undefined
}> {}

/** A live review needs a run directory to write its findings into; reached outside `runScopedLayers` is a wiring bug. */
export class PlanReviewRunRootMissing extends Data.TaggedError("PLAN_REVIEW_RUN_ROOT_MISSING")<{}> {}

/** `git ls-files` for the rulings files failed. */
export class PlanReviewGitFailed extends Data.TaggedError("PLAN_REVIEW_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** `writeArtifact`'s own `PlatformError` on the findings write, caught and named. */
export class PlanFindingsWriteFailed extends Data.TaggedError("PLAN_FINDINGS_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}
