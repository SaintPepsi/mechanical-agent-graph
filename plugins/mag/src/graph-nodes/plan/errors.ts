import { Data } from "effect"

/**
 * The session ended but `plan.md` it was told to write is absent, empty after trim, or
 * byte-identical to its pre-dispatch snapshot — `brainstorm`'s `DesignMissing` rule applied to
 * the plan. `sessions` travels with it because the spend already happened by this point.
 */
export class PlanMissing extends Data.TaggedError("PLAN_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/** A git read this node depends on failed: `commitPath`'s `git add`, or the `rev-parse` that stamps `headSha`. `BrainstormGitFailed`'s shape. */
export class PlanGitFailed extends Data.TaggedError("PLAN_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** `git commit` failed after a real session already produced `plan.md`. `BrainstormCommitFailed`'s shape. */
export class PlanCommitFailed extends Data.TaggedError("PLAN_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

/** The mechanical copy of `plan.md` into the run root failed, or the run has no run root. `BrainstormCopyFailed`'s shape. */
export class PlanCopyFailed extends Data.TaggedError("PLAN_COPY_FAILED")<{
  readonly path: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}
