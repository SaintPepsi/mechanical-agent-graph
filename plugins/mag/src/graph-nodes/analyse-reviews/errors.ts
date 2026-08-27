import { Data } from "effect"

/**
 * The manifest at `path` does not read back as a `ReviewWindow`: a
 * missing file, invalid JSON, or a decode failure against the schema. A file is a trust boundary,
 * and within one run this can only mean `gather-reviews` and this node disagree about the schema —
 * a wiring bug, not a data problem.
 */
export class WindowUnreadable extends Data.TaggedError("WINDOW_UNREADABLE")<{
  readonly path: string
  readonly detail: string
}> {}

/**
 * The reply did not attribute every blocked/dispute-rejected pass in the window. The report
 * is not written and the watermark does not advance, so the same window is
 * re-gathered and re-analysed next time rather than being silently recorded as done.
 */
export class AnalysisIncomplete extends Data.TaggedError("ANALYSIS_INCOMPLETE")<{
  readonly missing: readonly string[]
}> {}

/** A live run needs a run directory to write its report into — the house form (`BuildRunRootMissing`, `ReviewRunRootMissing`, `WindowRunRootMissing`). */
export class AnalysisRunRootMissing extends Data.TaggedError("ANALYSIS_RUN_ROOT_MISSING")<{}> {}

/** `writeArtifact`'s own `PlatformError`, caught and named — same precedent as `build/errors.ts`'s `BuildSummaryWriteFailed`. */
export class ReportWriteFailed extends Data.TaggedError("REPORT_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}
