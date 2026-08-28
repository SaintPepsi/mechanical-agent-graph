import { Data } from "effect"

/** The design record at `path` could not be read. A file is a trust boundary: it is read here, never assumed present. */
export class DesignRulingsUnreadable extends Data.TaggedError("DESIGN_RULINGS_UNREADABLE")<{
  readonly path: string
  readonly detail: string
}> {}

/** The comment body could not be written into the run root; `runRoot` is `""` when the node ran outside a run. */
export class DesignRulingsWriteFailed extends Data.TaggedError("DESIGN_RULINGS_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}
