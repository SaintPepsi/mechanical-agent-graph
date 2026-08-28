import { Effect, FileSystem, Schema } from "effect"
import { AcceptanceCriteriaMissing, TicketUnreadable } from "mag/graph-nodes/require-acs/errors"
import { recognizeAcceptanceCriteria } from "mag/graph-nodes/require-acs/recognizer"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"

/**
 * The door between `fetch-ticket` and everything that spends — worktree, branch, model
 * sessions. One file read and no agent: the whole decision is a function of the ticket file
 * `fetch-ticket` already wrote, so there is no capability here that could draft acceptance
 * criteria even by accident.
 */
export const requireAcs = make({
  name: "require-acs",
  description: "Refuse a run whose ticket carries no acceptance criteria.",
  input: Schema.Struct({ ticket: Schema.String, title: Schema.String, ticketPath: Schema.String }),
  success: Schema.Struct({ ticket: Schema.String, criteria: Schema.Int }),
  run: (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const body = yield* fs.readFileString(input.ticketPath).pipe(
        Effect.mapError((error) => new TicketUnreadable({ ticket: input.ticket, path: input.ticketPath, detail: String(error) }))
      )
      const { criteria, headings } = recognizeAcceptanceCriteria(body)
      if (criteria.length === 0) {
        return yield* Effect.fail(
          new AcceptanceCriteriaMissing({ ticket: input.ticket, title: input.title, headings: headings.join(", ") })
        )
      }
      return { ticket: input.ticket, criteria: criteria.length }
    }).pipe(Effect.provide(platform))
})
