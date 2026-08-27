import { Effect, FileSystem, Option, Schema } from "effect"
import { CommentBodyMissing, CommentFailed, CommentTrackerUnreachable } from "mag/graph-nodes/comment-ticket/errors"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { Shell } from "mag/runtime/shell"

// The trailing <PREFIX>-<n> segment of the ticket id; duplicated here since a sibling node's private module isn't importable.
const issueNumber = (ticket: string): Option.Option<string> => {
  const n = ticket.slice(ticket.lastIndexOf("-") + 1)
  return /^[0-9]+$/.test(n) ? Option.some(n) : Option.none()
}

/** `gh`'s own documented exits (`gh help exit-codes`), mapped onto tags. */
const failureFor = (ticket: string, exitCode: number, stderr: string) => {
  const detail = stderr.trim()
  if (exitCode === 4) return new CommentTrackerUnreachable({ ticket, detail })
  return new CommentFailed({ ticket, exitCode, detail })
}

/**
 * Posts a file's contents as a tracker comment: the mechanical half of `review-pattern-graph`'s
 * tail, so posting a report is a shell call with an exit-code mapping, never a sentence in
 * `analyse-reviews`'s prompt asking a model to post its own output.
 *
 * The file's existence is checked before anything is spawned (`fs.exists`, not a stat inside the
 * shell call) — a report path that never got written is this node's own named failure, not `gh`'s
 * usage error to interpret.
 *
 * The body travels by `--body-file`, never as argv text: a report can exceed argv's size limit.
 */
export const commentTicket = make({
  name: "comment-ticket",
  description: "Post a file's contents as a comment on the ticket.",
  input: Schema.Struct({
    ticket: Schema.String,
    path: Schema.String
  }),
  success: Schema.Struct({ ticket: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      if (!(yield* fs.exists(input.path))) return yield* Effect.fail(new CommentBodyMissing({ path: input.path }))

      const n = issueNumber(input.ticket)
      if (Option.isNone(n)) {
        return yield* Effect.fail(
          new CommentFailed({ ticket: input.ticket, exitCode: 0, detail: `cannot map '${input.ticket}' to an issue number` })
        )
      }

      const shell = yield* Shell
      const result = yield* shell.run(["gh", "issue", "comment", n.value, "--body-file", input.path])
      if (result.exitCode !== 0) {
        return yield* Effect.fail(failureFor(input.ticket, result.exitCode, result.stderr))
      }

      return { ticket: input.ticket }
    }).pipe(Effect.provide(platform))
})
