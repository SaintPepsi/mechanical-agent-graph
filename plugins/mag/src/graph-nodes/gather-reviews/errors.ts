import { Data } from "effect"

/**
 * The trigger, expressed as the railway: fewer than `size` review
 * passes have completed since `since`. The ordinary outcome of most invocations, reached before any
 * dispatch — an invocation with nothing to do costs one directory scan, never a session.
 */
export class WindowNotFull extends Data.TaggedError("WINDOW_NOT_FULL")<{
  readonly passes: number
  readonly size: number
  readonly since: string
}> {}

/**
 * A live run needs a run directory to write `window.json` into — the `BuildRunRootMissing` /
 * `ReviewRunRootMissing` precedent, for a node reached outside `runScopedLayers`.
 */
export class WindowRunRootMissing extends Data.TaggedError("WINDOW_RUN_ROOT_MISSING")<{}> {}

/** The manifest write itself failed — a caught `PlatformError`, named rather than left raw, `BuildSummaryWriteFailed`'s precedent. */
export class WindowWriteFailed extends Data.TaggedError("WINDOW_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}
