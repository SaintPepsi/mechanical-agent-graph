import { Effect, Schema } from "effect"
import { MissingTicketId } from "mag/graph-nodes/format-branch-name/errors"
import { formatBranchName, normaliseTicketId } from "mag/graph-nodes/format-branch-name/format"
import { make } from "mag/runtime/graph-node.definition"

export const formatBranchNameNode = make({
  name: "format-branch-name",
  description: "Compute the branch name a ticket should use.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.optional(Schema.String),
    // Labels decide the branch's type slot (`bugfix/`, `chore/`, `task/`, else `feat/`). No node
    // produces them yet — `fetch-ticket`'s success shape carries title and body only — so a graph
    // composing this passes an empty list and gets the `feat/` default. That gap is meant to be
    // visible here.
    labels: Schema.optional(Schema.Array(Schema.String))
  }),
  success: Schema.Struct({ branch: Schema.String }),
  run: (input) => {
    const id = normaliseTicketId(input.ticket)
    if (id === "") return Effect.fail(new MissingTicketId({ ticket: input.ticket }))
    return Effect.succeed({ branch: formatBranchName(id, input.title ?? "", input.labels ?? []) })
  }
})
