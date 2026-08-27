import { Data } from "effect"

/** `HEAD` is not the sha the caller said it was writing on top of; checked before any dispatch (`simplify/errors.ts`'s `SimplifyHeadMoved`). */
export class WriteRedHeadMoved extends Data.TaggedError("WRITE_RED_HEAD_MOVED")<{
  readonly expected: string
  readonly observed: string
}> {}

/** One of the node's own git reads failed (the head gate, the dirty-tree gate, the changed-paths read, the post-commit sha). */
export class WriteRedGitFailed extends Data.TaggedError("WRITE_RED_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** The tree was dirty before the session ran: `git add -A` cannot tell the session's tests from dirt that predates them (`build/errors.ts`'s `BuildWorkdirDirty`). */
export class WriteRedWorkdirDirty extends Data.TaggedError("WRITE_RED_WORKDIR_DIRTY")<{
  readonly paths: readonly string[]
}> {}

/** The node's own `git add`/`git commit` exited non-zero; the tests are still in the tree, salvageable by hand (`build/errors.ts`'s `BuildCommitFailed`). */
export class WriteRedCommitFailed extends Data.TaggedError("WRITE_RED_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

/** The session declared no test file at all: a red-first pass with nothing red is not a pass. */
export class WriteRedNoTests extends Data.TaggedError("WRITE_RED_NO_TESTS")<{
  readonly sessions: readonly string[]
}> {}

/**
 * The commit touched paths the session did not declare as a test or a stub. The declaration is the
 * only way a caller learns which files are tests (and so which files `implement` may not touch),
 * so a path outside it is a hole in the gate that follows, not a detail to let through.
 */
export class WriteRedPathsUndeclared extends Data.TaggedError("WRITE_RED_PATHS_UNDECLARED")<{
  readonly paths: readonly string[]
  readonly sessions: readonly string[]
}> {}

/** A declared test or stub path is not in the commit: the session named a file it did not write. */
export class WriteRedPathsMissing extends Data.TaggedError("WRITE_RED_PATHS_MISSING")<{
  readonly paths: readonly string[]
  readonly sessions: readonly string[]
}> {}
