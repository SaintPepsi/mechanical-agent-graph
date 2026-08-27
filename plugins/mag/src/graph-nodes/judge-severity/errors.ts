import { Data } from "effect"

/** The escapes file lands in the run root; a node reached with none is a wiring bug (`build/errors.ts`'s `BuildRunRootMissing`). */
export class SeverityRunRootMissing extends Data.TaggedError("SEVERITY_RUN_ROOT_MISSING")<{}> {}

/** `writeArtifact`'s own `PlatformError` on the escapes file, caught and named. */
export class SeverityEscapesWriteFailed extends Data.TaggedError("SEVERITY_ESCAPES_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}

/**
 * The judge did not rate every escape exactly once. A missing rating cannot be defaulted (to
 * what, and in which direction?) and a duplicate cannot be chosen between, so the reply is
 * refused whole rather than partially trusted. `missing` and `duplicated` name the indexes.
 */
export class SeverityRatingsIncomplete extends Data.TaggedError("SEVERITY_RATINGS_INCOMPLETE")<{
  readonly missing: readonly number[]
  readonly duplicated: readonly number[]
  readonly sessions: readonly string[]
}> {}
