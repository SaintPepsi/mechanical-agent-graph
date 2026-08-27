import { Data } from "effect"

/**
 * The remote refused the push — a protected-branch hook, a rejected ref, an unreachable remote.
 * One tag for every non-zero `git push`, carrying the remote's own message verbatim: the honest
 * outcome is to surface exactly what the remote said and stop, so nothing here distinguishes
 * "retryable" cases — retrying is not this node's business.
 */
export class PushRejected extends Data.TaggedError("PUSH_BRANCH_REJECTED")<{
  readonly remote: string
  readonly branch: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * `git status --porcelain` reported at least one modified or untracked path at push time.
 * Build agents sometimes fail to commit part of their work, and `verification` tests the working
 * tree, not the commit, so a push after that would silently publish less than the suite verified.
 * The fix is upstream (the build agent commits its work) — this node only reports.
 */
export class PushDirty extends Data.TaggedError("PUSH_BRANCH_DIRTY")<{
  readonly paths: readonly string[]
}> {}

/** Zero commits between `base` and `HEAD` — nothing for this push to publish. */
export class PushEmpty extends Data.TaggedError("PUSH_BRANCH_EMPTY")<{
  readonly branch: string
  readonly base: string
}> {}

/** One of the two preflight git calls itself failed — the node can't answer its own question. */
export class PushGitFailed extends Data.TaggedError("PUSH_BRANCH_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}
