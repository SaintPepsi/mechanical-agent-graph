import { Effect, Schema } from "effect"
import { AcceptanceCriteriaMissing } from "mag/graph-nodes/require-acs/errors"
import { recognizeAcceptanceCriteria } from "mag/graph-nodes/require-acs/recognizer"
import { make } from "mag/runtime/graph-node.definition"

/**
 * The door between `fetch-ticket` and everything that spends — worktree, branch, model
 * sessions. Pure, in the shape of `format-branch-name` (no `Shell`, no agent, no `R` channel at
 * all): the whole decision is a function of the body `fetch-ticket` already fetched, so there is no
 * capability here that could draft acceptance criteria even by accident.
 */
export const requireAcs = make({
  name: "require-acs",
  description: "Refuse a run whose ticket carries no acceptance criteria.",
  input: Schema.Struct({ ticket: Schema.String, title: Schema.String, body: Schema.String }),
  success: Schema.Struct({ ticket: Schema.String, criteria: Schema.Int }),
  run: (input) => {
    const { criteria, headings } = recognizeAcceptanceCriteria(input.body)
    if (criteria.length === 0) {
      return Effect.fail(
        new AcceptanceCriteriaMissing({ ticket: input.ticket, title: input.title, headings: headings.join(", ") })
      )
    }
    return Effect.succeed({ ticket: input.ticket, criteria: criteria.length })
  }
})
