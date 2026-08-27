import type { Concern } from "mag/skills/design/concern"
import { GRAPH_NODE_MARKER_LEGEND } from "mag/skills/ticket/schema"

/** Renders `GRAPH_NODE_MARKER_LEGEND` rather than a second gloss of the glyphs, so the prompt and
 * the reply schema's own field description can't disagree about what a marker means. */
export const graphNodes: Concern<"any"> = {
  id: "graph-nodes",
  audience: "any",
  section: {
    heading: "Graph nodes:",
    body: () =>
      [
        "- List every GraphNode this ticket adds, changes, or removes, empty when it touches none.",
        `- Marker: ${GRAPH_NODE_MARKER_LEGEND}`
      ].join("\n") + "\n\n"
  }
}
