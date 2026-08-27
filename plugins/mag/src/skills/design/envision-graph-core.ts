import graphMermaidNotation from "mag/docs/envision/graph-mermaid-notation.md" with { type: "text" }
import graphMermaidVision from "mag/docs/envision/graph-mermaid-vision.envision.md" with { type: "text" }
import type { Concern } from "mag/skills/design/concern"
import { envisionDocBody } from "mag/skills/design/concern"

/**
 * This repository's own envisioning notation — the ideal graph drawn as a mermaid diagram. The
 * discipline is `plugins/mag/docs/envision/graph-mermaid-vision.envision.md`, the grammar is
 * `graph-mermaid-notation.md`, both spliced whole (see `envisionDocBody`), discipline first.
 * Selected via `detect-graph-core` because the design lane's target checkout may or may not be this
 * repository; the module joins no other stack's composed prompt. It teaches drawing only: what a
 * drawn node must justify against the runtime boundary is review's business (`PRINCIPLES.md`,
 * "A vision names GraphNodes"), not the envisioning session's — an envisioning prompt that talks
 * about the current `runtime/` is already failing its own blindness rule.
 */
export const envisionGraphCore: Concern<"any"> = {
  id: "envision-graph-core",
  audience: "any",
  section: {
    heading: "",
    body: () => envisionDocBody(graphMermaidVision) + envisionDocBody(graphMermaidNotation)
  }
}
