import { describe, expect, test } from "bun:test"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { GRAPH_NODE_MARKER_LEGEND, TicketSchema } from "mag/skills/ticket/schema"

/**
 * Goes through `verdictSchema` exactly the way `graph-node.ts` builds the reply schema
 * (`verdictSchema(TicketSchema)`), the same call rather than a re-derivation: the claim is about
 * what a model reading `--json-schema` actually sees, and only the real conversion proves that.
 */
describe("TicketSchema's marker field carries its own meaning into the dispatched JSON schema", () => {
  const serialized = verdictSchema(TicketSchema).serialized

  test("the marker legend text is present in the schema the model receives", () => {
    expect(serialized).toContain(GRAPH_NODE_MARKER_LEGEND)
  })

  test("the marker enum itself still emits, so the legend is a gloss on it, not a replacement for it", () => {
    expect(serialized).toContain("\"+\"")
    expect(serialized).toContain("\"%\"")
    expect(serialized).toContain("\"-\"")
  })
})
