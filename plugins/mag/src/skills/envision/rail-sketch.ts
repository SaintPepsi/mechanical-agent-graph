import graphRailSketch from "mag/docs/envision/graph-rail-sketch.envision.md" with { type: "text" }
import { envisionDocBody } from "mag/skills/design/concern"

export interface EnvisionRailSketchParams {
  readonly name: string
  readonly visionPath: string
  readonly destination: string
}

/**
 * The rail-sketch dispatch's whole prompt, `mermaid.ts`'s sibling — same flat shape, a distinct
 * session and a distinct destination, the vision named as read-only input. That vision travels
 * as a path the session reads itself, never inlined as prompt text: an artifact travels as a
 * reference, not as inlined content, because an oversized prompt dies at `execve`. The discipline is
 * `plugins/mag/docs/envision/graph-rail-sketch.envision.md`, spliced whole (`envisionDocBody`): the
 * maintainer-editable single source for how a graph's composition is sketched — an ideal, not final
 * code, the body of a graph or GraphNode, never a whole file.
 */
export const compileEnvisionRailSketch = (params: EnvisionRailSketchParams): string =>
  `Read the mermaid vision at \`${params.visionPath}\` (read-only input; do not write to it). Sketch ` +
  `how the graph \`${params.name}\` it draws is composed, in the notation below.\n\n` +
  envisionDocBody(graphRailSketch) +
  // Same rule as `mermaid.ts`: the node commits, the session only writes.
  `Write the rail-sketch to \`${params.destination}\`. Do not write the mermaid vision — that was a ` +
  `separate session's job.`
