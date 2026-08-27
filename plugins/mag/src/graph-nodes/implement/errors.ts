import { Data } from "effect"

/** The dispute artifact lands in the run root; a node reached with none is a wiring bug (`build/errors.ts`'s `BuildRunRootMissing`). */
export class ImplementRunRootMissing extends Data.TaggedError("IMPLEMENT_RUN_ROOT_MISSING")<{}> {}

/** `HEAD` is not the sha the caller said the red tests sit on; checked before any dispatch (`simplify/errors.ts`'s `SimplifyHeadMoved`). */
export class ImplementHeadMoved extends Data.TaggedError("IMPLEMENT_HEAD_MOVED")<{
  readonly expected: string
  readonly observed: string
}> {}

/** One of the node's own git reads failed, so "did the session commit anything" has no answer. */
export class ImplementGitFailed extends Data.TaggedError("IMPLEMENT_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** The tree was dirty before the session ran (`build/errors.ts`'s `BuildWorkdirDirty`). */
export class ImplementWorkdirDirty extends Data.TaggedError("IMPLEMENT_WORKDIR_DIRTY")<{
  readonly paths: readonly string[]
}> {}

/** The node's own `git add`/`git commit` exited non-zero; the work is still in the tree (`build/errors.ts`'s `BuildCommitFailed`). */
export class ImplementCommitFailed extends Data.TaggedError("IMPLEMENT_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

/** Zero forward commits with `HEAD` where the pass found it, and no dispute: silence, not an answer to red tests. */
export class ImplementNoCommits extends Data.TaggedError("IMPLEMENT_NO_COMMITS")<{
  readonly sessions: readonly string[]
}> {}

/** `writeArtifact`'s own `PlatformError` on the dispute file, caught and named. */
export class ImplementDisputeWriteFailed extends Data.TaggedError("IMPLEMENT_DISPUTE_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}

/** `resume` with no `addendum` would dispatch a resumed session with nothing to do, at full price (`build/errors.ts`'s `BuildResumeEmpty`). */
export class ImplementResumeEmpty extends Data.TaggedError("IMPLEMENT_RESUME_EMPTY")<{}> {}

/**
 * The session disputes a test rather than making it pass. A red test disputes code or spec and
 * is never weakened, so the disagreement is recorded on disk and escalated whole: nothing in the
 * lane can adjudicate it, and a loop that tried would be inventing a fix for a test it disagrees
 * with. Carries the pass's spend and head for the caller's ledger.
 */
export class TestDisputed extends Data.TaggedError("TEST_DISPUTED")<{
  readonly disputePath: string
  readonly headSha: string
  readonly commits: number
  readonly sessions: readonly string[]
  readonly costUsd: number | null
}> {}
