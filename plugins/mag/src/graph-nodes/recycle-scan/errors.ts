import { Data } from "effect"

/** The design at `designPath` could not be read: a file is a trust boundary, read here, never assumed present. */
export class RecycleScanDesignUnreadable extends Data.TaggedError("RECYCLE_SCAN_DESIGN_UNREADABLE")<{
  readonly path: string
  readonly detail: string
}> {}

/** `git ls-files` exited non-zero, `gitReadRaw`'s failure shape: the file list is git's, never a directory walk's. */
export class RecycleScanGitFailed extends Data.TaggedError("RECYCLE_SCAN_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** A file git tracks could not be read where the scan looked for it: the checkout and the index disagree, which the scan cannot judge. */
export class RecycleScanFileUnreadable extends Data.TaggedError("RECYCLE_SCAN_FILE_UNREADABLE")<{
  readonly path: string
  readonly detail: string
}> {}

/** The scan could not land in the run root: the run root is missing (checked before any read), or the write failed. */
export class RecycleScanWriteFailed extends Data.TaggedError("RECYCLE_SCAN_WRITE_FAILED")<{
  readonly path: string
  readonly detail: string
}> {}
