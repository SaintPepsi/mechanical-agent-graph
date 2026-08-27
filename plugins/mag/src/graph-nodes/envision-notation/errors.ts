import { Data } from "effect"

/** `input.notation` names no id `NOTATIONS` carries — a caller mistake, checked before any session
 * dispatches. */
export class UnknownNotation extends Data.TaggedError("UNKNOWN_NOTATION")<{
  readonly notation: string
  readonly known: readonly string[]
}> {}

/**
 * The session declared its own failure — `verdict.blocked` present, `build`'s `dispute` idiom read
 * as this node's own "trust a declared failure" mechanism. Trusted immediately: no disk read, no
 * commit, no retry. Siblings in `envision-visions` keep running regardless.
 */
export class NotationVisionBlocked extends Data.TaggedError("NOTATION_VISION_BLOCKED")<{
  readonly notation: string
  readonly reason: string
  readonly sessions: readonly string[]
}> {}

/**
 * The session declared success but the vision is missing, empty after trim, or byte-identical to
 * its pre-dispatch snapshot — `envision-mermaid`'s `VisionMissing` precedent, one notation wide. The
 * snapshot compare is what catches a re-run's stale document (a re-run overwrites in place):
 * presence alone would pass a session that dispatched and wrote nothing. `envision-visions` retries
 * this tag once, alone; every other tag here reaches its caller untouched.
 */
export class NotationVisionMissing extends Data.TaggedError("NOTATION_VISION_MISSING")<{
  readonly notation: string
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/**
 * The mechanical copy of the vision into the run root failed — the run dir couldn't be made, or the
 * copy couldn't be written, after a real session already produced it. `design/errors.ts`'s
 * `DesignCopyFailed` precedent, generalised by `records.ts`'s `record`.
 */
export class NotationVisionCopyFailed extends Data.TaggedError("NOTATION_VISION_COPY_FAILED")<{
  readonly path: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}

/** `commitPath`'s git-failure constructor, closed into this node's own union — `git add` failed. */
export class NotationVisionGitFailed extends Data.TaggedError("NOTATION_VISION_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** `commitPath`'s commit-failure constructor: `git commit` failed after a real session already produced the vision. */
export class NotationVisionCommitFailed extends Data.TaggedError("NOTATION_VISION_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}
