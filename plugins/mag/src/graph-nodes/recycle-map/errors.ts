import { Data } from "effect"

/** The session ended but the map it was told to write is absent, blank, or unchanged: a failed pass, never trusted from the session's own claim. */
export class RecycleMapMissing extends Data.TaggedError("RECYCLE_MAP_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/** The node's own scoped `git add`/`git commit` exited non-zero after a real map landed on disk: `discover/errors.ts`'s shape. */
export class RecycleMapCommitFailed extends Data.TaggedError("RECYCLE_MAP_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly sessions: readonly string[]
}> {}

/** The mechanical copy of the map into the run root failed, after a real session already produced it. */
export class RecycleMapCopyFailed extends Data.TaggedError("RECYCLE_MAP_COPY_FAILED")<{
  readonly path: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}
