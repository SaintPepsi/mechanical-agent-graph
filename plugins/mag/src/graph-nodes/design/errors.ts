import { Data } from "effect"

/**
 * A live design run needs a run directory to copy `design.md` into. `RunInfo`'s default `runRoot`
 * is `""` for exactly the case where none was ever wired up — a design node reached outside
 * `runScopedLayers`. That is a wiring bug, not a data problem: unfit paths error rather than being
 * worked around (repo ruling, `CLAUDE.md`), so this fails before any prompt is sent.
 */
export class DesignRunRootMissing extends Data.TaggedError("DESIGN_RUN_ROOT_MISSING")<{}> {}

/**
 * The session ended but the design file it was told to write is absent or blank. The agent writes
 * the artifact, never the node, so a missing file is a failed design pass, not something to paper
 * over: splicing nothing into build's prompt would silently reduce develop-graph to a build with no design.
 * `sessions` travels with it because the cost was already spent by this point.
 */
export class DesignFileMissing extends Data.TaggedError("DESIGN_FILE_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/**
 * The mechanical copy of the repo's design into the run root failed — the run dir couldn't be
 * made, or the copy couldn't be written, after a real session already produced the design.
 * `create/scaffold.ts`'s `ScaffoldFailed` is the precedent: a platform error caught and named
 * rather than left raw, so a node's inferred error union stays domain tags only.
 */
export class DesignCopyFailed extends Data.TaggedError("DESIGN_COPY_FAILED")<{
  readonly path: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}

/** The `rev-parse HEAD` that stamps this pass's `headSha` exited non-zero, after the copy already succeeded. */
export class DesignGitFailed extends Data.TaggedError("DESIGN_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}
