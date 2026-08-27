import { Schema } from "effect"

/**
 * The house ticket's structure: `write-ticket`'s verdict schema and `github-ticket-create`'s
 * decode target are this one definition, so neither can drift from what the other expects. Shared
 * here, not node-private, because both nodes need it and a sibling's private module isn't
 * importable — `mag/skills/*` is the sanctioned shared seam for exactly this case.
 */

/** `.github/ISSUE_TEMPLATE/ticket.md`'s own vocabulary — the repo's declared list, not the wider set real filed tickets sometimes carry. */
export const TICKET_TYPES = ["Story", "Task", "Bug"] as const

/** A `GraphNodes:` header entry's marker: added, changed, removed. */
export const GRAPH_NODE_MARKERS = ["+", "%", "-"] as const

/**
 * `GRAPH_NODE_MARKERS`' own meaning, spliced into both the schema's field description and
 * `graph-nodes.ts`'s prompt text: a bare `["+", "%", "-"]` enum carries no meaning at dispatch, and
 * a second copy of the gloss would be free to drift from this one.
 */
export const GRAPH_NODE_MARKER_LEGEND = "`+` added, `%` changed, `-` removed."

export const AcceptanceCriterionSchema = Schema.Struct({
  title: Schema.String,
  given: Schema.String,
  when: Schema.String,
  then: Schema.Array(Schema.String),
  /** The provided criterion sentence this one carries, verbatim; absent when the writer added it. `Schema.optionalKey`, not a nullable union — an absent field stays absent rather than encoding as an explicit null. */
  source: Schema.optionalKey(Schema.String)
})

export const GraphNodeRefSchema = Schema.Struct({
  marker: Schema.Literals(GRAPH_NODE_MARKERS).annotate({ description: GRAPH_NODE_MARKER_LEGEND }),
  name: Schema.String
})

/**
 * Criterion ids are not a field: `AC.01`/`AC.02` are positions in `acceptanceCriteria`, rendered by
 * `render.ts`, never a number the session has to keep in step with a list it is already emitting in
 * order.
 */
export const TicketSchema = Schema.Struct({
  title: Schema.String,
  executiveSummary: Schema.String,
  type: Schema.Literals(TICKET_TYPES),
  component: Schema.Array(Schema.String),
  context: Schema.String,
  acceptanceCriteria: Schema.Array(AcceptanceCriterionSchema),
  dependsOn: Schema.Array(Schema.String),
  blocks: Schema.Array(Schema.String),
  graphNodes: Schema.Array(GraphNodeRefSchema)
})
export type Ticket = typeof TicketSchema.Type
