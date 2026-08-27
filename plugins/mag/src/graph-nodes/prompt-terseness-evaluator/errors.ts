import { Data } from "effect"

/** Reached outside a live run: a wiring bug, not a recoverable state. */
export class TersenessRunRootMissing extends Data.TaggedError("TERSENESS_RUN_ROOT_MISSING")<{}> {}

/** Checked before any other read and before any dispatch, so a moved tree burns no session. */
export class TersenessHeadMoved extends Data.TaggedError("TERSENESS_HEAD_MOVED")<{
  readonly expected: string
  readonly observed: string
}> {}

/** One of this node's own git reads exited non-zero; it stops rather than guessing at the answer. */
export class TersenessGitFailed extends Data.TaggedError("TERSENESS_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** A failed write, not a failed measurement: the session's rewrite is still sitting in the tree, salvageable by hand. */
export class TersenessCommitFailed extends Data.TaggedError("TERSENESS_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

/** Caught before any spend: pre-existing dirt would otherwise be folded into this node's own commit. */
export class TersenessWorkdirDirty extends Data.TaggedError("TERSENESS_WORKDIR_DIRTY")<{
  readonly paths: readonly string[]
}> {}
