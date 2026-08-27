import { Data } from "effect"

/** A live run needs a run directory to copy the derived vision into (same house form as `AnalysisRunRootMissing`, `BuildRunRootMissing`, `PrBodyRunRootMissing`). */
export class DerivationRunRootMissing extends Data.TaggedError("DERIVATION_RUN_ROOT_MISSING")<{}> {}

/**
 * The session declared success but the drawing at `destination` is missing or empty after trim.
 * No before-dispatch snapshot, unlike `envision-mermaid/errors.ts`'s `VisionMissing`: `codeRoot` is
 * a fresh temp copy of the source tree per run and never holds a drawing before dispatch, so a
 * byte-identical check would guard a state this node cannot reach (`PRINCIPLES.md`, no guards for
 * failures never experienced). No retry: a session that cannot write the notation is a broken
 * prompt, and the prompt is the input to adjust.
 */
export class DerivationEmpty extends Data.TaggedError("DERIVATION_EMPTY")<{
  readonly destination: string
  readonly sessions: readonly string[]
}> {}

/**
 * A real drawing was produced at `<codeRoot>/derived-vision.md`, but `writeArtifact`'s copy of it
 * into the run root failed. Named apart from `DerivationEmpty`: by this point a session already
 * spent real cost producing a real drawing, so this is a run-root write problem, not a prompt problem.
 */
export class DerivedCopyFailed extends Data.TaggedError("DERIVED_COPY_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}
