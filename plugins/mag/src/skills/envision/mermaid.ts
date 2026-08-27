import graphMermaidNotation from "mag/docs/envision/graph-mermaid-notation.md" with { type: "text" }
import graphMermaidVision from "mag/docs/envision/graph-mermaid-vision.envision.md" with { type: "text" }
import { envisionDocBody } from "mag/skills/design/concern"

export interface EnvisionMermaidParams {
  readonly name: string
  readonly destination: string
}

/**
 * The mermaid dispatch's whole prompt. The discipline is
 * `plugins/mag/docs/envision/graph-mermaid-vision.envision.md`, the notation grammar is
 * `graph-mermaid-notation.md`, both hard-imported and spliced whole (`envisionDocBody`), discipline
 * first — the docs are the maintainer-editable single source, carried mechanically so the session
 * never has to go read them. Names `vision.md` as the one destination and never `rail-sketch.md`,
 * so a mermaid dispatch can never be confused for the rail-sketch one. The node commits
 * mechanically under a pathspec limited to its own artifact, so the prompt asks for nothing
 * git-shaped.
 */
export const compileEnvisionMermaid = (params: EnvisionMermaidParams): string =>
  `Envision the graph \`${params.name}\`, in the notation below, at full granularity: branch names, ` +
  `checkouts, worktrees, and PRs are drawn rather than elided.\n\n` +
  envisionDocBody(graphMermaidVision) +
  envisionDocBody(graphMermaidNotation) +
  `Write the vision to \`${params.destination}\`. Do not write a rail-sketch — that is a separate ` +
  `session's job.`
