import { Effect, Schema } from "effect"
import { githubTicketCreate } from "mag/graph-nodes/github-ticket-create/graph-node"
import { writeTicket } from "mag/graph-nodes/write-ticket/graph-node"
import { graph } from "mag/runtime/graph"

/**
 * ticket-writer: three one-sentence inputs plus an optional acceptance-criteria file, in; a filed
 * house-style ticket, out. No ticket id exists yet when this graph starts, so
 * its run scope names that directly rather than borrowing one — `{ ticket: "draft", ... }`:
 * every attempt of this graph, before any ticket exists, shares that run root.
 *
 * `worktree: false`: this graph creates no branch, commits nothing, and touches no checkout tree —
 * the same reasoning `design-graph` and `envision` state for their own `worktree: false`.
 */
export const ticketWriter = graph({
  name: "ticket-writer",
  description: "Turn What/Why/How and an optional acceptance-criteria file into a filed house-style ticket.",
  input: Schema.Struct({
    what: Schema.String,
    why: Schema.String,
    how: Schema.String,
    criteriaPath: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    issueUrl: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    bodyPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  scope: () => ({ ticket: "draft", graph: "ticket-writer", worktree: false }),
  // Straight-line: the filer runs only because the writer succeeded. A
  // dropped criterion or an off-schema reply fails the writer outright, before any file exists for
  // the filer to read, so there is no routing to express.
  pipeline: (input) =>
    Effect.gen(function* () {
      const written = yield* writeTicket.run(input)
      const filed = yield* githubTicketCreate.run({ ticketPath: written.ticketPath })

      return {
        issueUrl: filed.issueUrl,
        title: filed.title,
        ticketPath: written.ticketPath,
        bodyPath: filed.bodyPath,
        sessions: written.sessions,
        costUsd: written.costUsd
      }
    })
})
