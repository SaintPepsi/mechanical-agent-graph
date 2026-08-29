import { Data } from "effect"

/** `input.notations` names an id `NOTATIONS` doesn't carry: a caller mistake, checked before any session dispatches. */
export class UnknownNotation extends Data.TaggedError("UNKNOWN_NOTATION")<{
  readonly notation: string
  readonly known: readonly string[]
}> {}

/**
 * The session declared its own failure: `verdict.blocked` present, `build`'s `dispute` idiom read
 * as this node's "trust a declared failure" mechanism. Trusted immediately: no disk read of the
 * design, no retry. The reason is model prose, so it lands as `<runRoot>/vision-blocked-N.md` and
 * travels here by path: an error row records the tag alone, and a value on the payload would
 * reach nobody.
 */
export class ShellBlocked extends Data.TaggedError("SHELL_BLOCKED")<{
  readonly reasonPath: string
  readonly sessions: readonly string[]
}> {}

/** The declared reason could not land in the run root, after a real session already declared it. */
export class ShellReasonWriteFailed extends Data.TaggedError("SHELL_REASON_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}

/**
 * The session declared success but the design doc is missing, empty after trim, or byte-identical
 * to its pre-dispatch snapshot: `discover`'s `DiscoverNoteMissing` rule, the shell pass wide. The
 * snapshot compare is what catches a re-run's stale document; presence alone would pass a session
 * that dispatched and wrote nothing.
 */
export class ShellMissing extends Data.TaggedError("SHELL_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/** A run with no run directory is a wiring bug, not a data problem, checked before a session is paid for: `design`'s own `DesignRunRootMissing` precedent. */
export class ShellRunRootMissing extends Data.TaggedError("SHELL_RUN_ROOT_MISSING")<{}> {}
