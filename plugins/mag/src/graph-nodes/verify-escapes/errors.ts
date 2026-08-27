import { Data } from "effect"

/** Probe scripts land in the run root; a node reached with none is a wiring bug (`build/errors.ts`'s `BuildRunRootMissing`). */
export class VerifyEscapesRunRootMissing extends Data.TaggedError("VERIFY_ESCAPES_RUN_ROOT_MISSING")<{}> {}

/**
 * The suite was red before any claim was applied. Every claim would then "go red" for a reason
 * that has nothing to do with it, so the input is unfit and the node stops instead of discarding
 * all of them as false negatives.
 */
export class VerifyEscapesSuiteRed extends Data.TaggedError("VERIFY_ESCAPES_SUITE_RED")<{
  readonly command: string
  readonly exitCode: number
  readonly outputTail: string
}> {}

/** A probe script could not be written, so its claim cannot be tried and the run should not pretend it was. */
export class VerifyEscapesProbeWriteFailed extends Data.TaggedError("VERIFY_ESCAPES_PROBE_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}

/** Writing the mutated file failed: the tree is untouched, and a claim that cannot be applied is a claim that cannot be tried. */
export class VerifyEscapesMutationFailed extends Data.TaggedError("VERIFY_ESCAPES_MUTATION_FAILED")<{
  readonly path: string
  readonly detail: string
}> {}

/**
 * The original bytes could not be written back, or read back different. The tree now carries a
 * mutation the node introduced, which is the one state this node must never leave behind, so it
 * fails loudly with the path a human has to restore by hand.
 */
export class VerifyEscapesRestoreFailed extends Data.TaggedError("VERIFY_ESCAPES_RESTORE_FAILED")<{
  readonly path: string
  readonly detail: string
}> {}
