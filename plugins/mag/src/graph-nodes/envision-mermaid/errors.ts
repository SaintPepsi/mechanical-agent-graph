import { Data } from "effect"

/**
 * The session declared success but `vision.md` is missing, empty after trim, or byte-identical to
 * what was there before dispatch — the last case is a re-run whose session wrote nothing, caught
 * by comparing against a snapshot taken before dispatch rather than trusting presence alone. No
 * retry: retrying a failed notation pass belongs to the
 * design lane's own per-notation checks, not this node.
 */
export class VisionMissing extends Data.TaggedError("VISION_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/** `git add`/`git diff --cached` failed while committing the vision — `commitPath`'s own git-failure constructor, closed into this node's own union. */
export class EnvisionMermaidGitFailed extends Data.TaggedError("ENVISION_MERMAID_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** `git commit` failed while committing the vision, after a real session already produced it. */
export class EnvisionMermaidCommitFailed extends Data.TaggedError("ENVISION_MERMAID_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

/**
 * A live run needs a run directory before this node dispatches — `RunInfo`'s default `runRoot` is
 * `""` for exactly the case where none was ever wired up, a bare CLI run outside `runScopedLayers`.
 * That is a wiring bug, not a data problem: `design/errors.ts`'s `DesignRunRootMissing` precedent.
 */
export class EnvisionMermaidRunRootMissing extends Data.TaggedError("ENVISION_MERMAID_RUN_ROOT_MISSING")<{}> {}
