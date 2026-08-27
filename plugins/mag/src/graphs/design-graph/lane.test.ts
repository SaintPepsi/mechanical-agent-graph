import { describe, expect, test } from "bun:test"
import { brainstorm } from "mag/graph-nodes/brainstorm/graph-node"
import { discover } from "mag/graph-nodes/discover/graph-node"
import { envisionVisions } from "mag/graph-nodes/envision-visions/graph-node"
import { DESIGN_LANE } from "mag/skills/design/lane"

/**
 * `lane.ts`'s `DESIGN_LANE` names each step's node by a bare string, since `skills/design/`
 * cannot import a graph-node module (`graph-node.shape.ts`'s `ALLOW_RULES` is one-directional — this
 * graph may reach into `skills/design/`, not the reverse). This is the anchor on the other side: it
 * imports the three live nodes `pipeline` actually dispatches (`graph.ts`) and proves the lane's own
 * strings haven't drifted from their `.name`s, so a node rename shows up here rather than only as a
 * stale label in the installed skill.
 */
describe("DESIGN_LANE names the live design-graph nodes, in dispatch order", () => {
  test("the flattened node strings equal the three nodes' own .name, in the order graph.ts's pipeline dispatches them", () => {
    const nodes = DESIGN_LANE.flat().map((step) => step.node)
    expect(nodes).toEqual([envisionVisions.name, discover.name, brainstorm.name])
  })
})
