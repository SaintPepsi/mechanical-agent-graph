import { Data } from "effect"

/** The session declared success but `rail-sketch.md` is missing, empty after trim, or unchanged from its before-dispatch snapshot — the sibling of `envision-mermaid`'s `VisionMissing`. */
export class RailSketchMissing extends Data.TaggedError("RAIL_SKETCH_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/** `git add`/`git diff --cached` failed while committing the rail-sketch — `commitPath`'s own git-failure constructor, closed into this node's own union. */
export class EnvisionRailSketchGitFailed extends Data.TaggedError("ENVISION_RAIL_SKETCH_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** `git commit` failed while committing the rail-sketch, after a real session already produced it. */
export class EnvisionRailSketchCommitFailed extends Data.TaggedError("ENVISION_RAIL_SKETCH_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

/**
 * A live run needs a run directory before this node dispatches — `RunInfo`'s default `runRoot` is
 * `""` for exactly the case where none was ever wired up, a bare CLI run outside `runScopedLayers`.
 * That is a wiring bug, not a data problem: `design/errors.ts`'s `DesignRunRootMissing` precedent,
 * `envision-mermaid`'s own `EnvisionMermaidRunRootMissing` sibling.
 */
export class EnvisionRailSketchRunRootMissing extends Data.TaggedError("ENVISION_RAIL_SKETCH_RUN_ROOT_MISSING")<{}> {}
