import { Data } from "effect"

/** A live run needs a run directory to write the report into (same house form as `AnalysisRunRootMissing`, `BuildRunRootMissing`, `PrBodyRunRootMissing`, `DerivationRunRootMissing`). */
export class CompareRunRootMissing extends Data.TaggedError("COMPARE_RUN_ROOT_MISSING")<{}> {}

/**
 * `writeArtifact`'s own `PlatformError` on the report write, caught and named (`ReportWriteFailed`'s
 * precedent in `analyse-reviews/errors.ts`). No `sessions` field: this node dispatches no agent.
 * Tagged `COMPARE_REPORT_WRITE_FAILED`, not the bare `REPORT_WRITE_FAILED` `analyse-reviews/errors.ts`
 * already owns: the journal's fail event carries only `_tag`, so two nodes sharing a tag make one row
 * unattributable. `COMPARE_RUN_ROOT_MISSING` below is this file's own sibling doing the same thing.
 */
export class CompareReportWriteFailed extends Data.TaggedError("COMPARE_REPORT_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}
