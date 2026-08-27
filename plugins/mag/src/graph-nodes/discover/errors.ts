import { Data } from "effect"

/**
 * The session ended but the note it was told to write is absent or blank. The agent produces the
 * artifact, the node makes the commit, so a missing note is a failed recon pass, not something to
 * paper over — never trusting the session's own claim. `sessions` travels with it because the
 * spend already happened by this point.
 */
export class DiscoverNoteMissing extends Data.TaggedError("DISCOVER_NOTE_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/**
 * The node's own scoped `git add`/`git commit` exited non-zero, after a real note already landed on
 * disk. A failed *write*, not a failed measurement: the note is still sitting in the tree,
 * salvageable by hand — `simplify/errors.ts`'s `SimplifyCommitFailed` precedent, minus `stdout`:
 * `argv`/`exitCode`/`stderr`/`sessions` only.
 */
export class DiscoverCommitFailed extends Data.TaggedError("DISCOVER_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly sessions: readonly string[]
}> {}

/**
 * The mechanical copy of the note into the run root failed — the run dir couldn't be made, or the
 * copy couldn't be written, after a real session already produced the note. `design/errors.ts`'s
 * `DesignCopyFailed` precedent, generalised by `records.ts`'s `record`.
 */
export class DiscoverCopyFailed extends Data.TaggedError("DISCOVER_COPY_FAILED")<{
  readonly path: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}
