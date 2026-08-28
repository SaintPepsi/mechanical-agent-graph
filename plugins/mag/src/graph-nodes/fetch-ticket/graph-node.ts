import { Effect, FileSystem, Option, Schema } from "effect"
import {
  EmptyTicket,
  TicketNotAddressable,
  TicketNotMaintainerAuthored,
  TicketWriteFailed,
  TrackerFailed,
  TrackerUnreachable
} from "mag/graph-nodes/fetch-ticket/errors"
import { Issue, renderBody } from "mag/graph-nodes/fetch-ticket/render"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { requireRunRoot } from "mag/runtime/records"
import { RunInfo } from "mag/runtime/run-info"
import { Shell, type ShellResult } from "mag/runtime/shell"

// The ticket-id convention: the trailing <PREFIX>-<n> segment.
const issueNumber = (ticket: string): Option.Option<string> => {
  const n = ticket.slice(ticket.lastIndexOf("-") + 1)
  return /^[0-9]+$/.test(n) ? Option.some(n) : Option.none()
}

// gh has no documented exit code for "no such issue" (both a bad number and a missing remote exit 1); match its literal message instead.
const NOT_FOUND = "Could not resolve to an issue or pull request"

const failureFor = (ticket: string, result: ShellResult): TicketNotAddressable | TrackerUnreachable | TrackerFailed => {
  const detail = result.stderr.trim()
  if (result.exitCode === 4) return new TrackerUnreachable({ ticket, detail })
  if (detail.includes(NOT_FOUND)) return new TicketNotAddressable({ ticket, detail })
  return new TrackerFailed({ ticket, exitCode: result.exitCode, detail })
}

// The node's one forge seam: one gh issue view call, decoded to Issue. Yields Shell itself, no service parameter.
const fetchIssue = (ticket: string): Effect.Effect<Issue, TicketNotAddressable | TrackerUnreachable | TrackerFailed> =>
  Effect.gen(function* () {
    const n = issueNumber(ticket)
    if (Option.isNone(n)) {
      return yield* Effect.fail(new TicketNotAddressable({ ticket, detail: `cannot map '${ticket}' to an issue number` }))
    }

    const shell = yield* Shell
    const result = yield* shell.run(["gh", "issue", "view", n.value, "--json", "title,body,author,comments"]).pipe(
      Effect.catchTag("SHELL_COMMAND_NOT_EXECUTABLE", (error) =>
        Effect.fail(new TrackerUnreachable({ ticket, detail: error.detail })))
    )
    if (result.exitCode !== 0) return yield* Effect.fail(failureFor(ticket, result))

    return yield* Schema.decodeUnknownEffect(Issue)(result.stdout).pipe(
      Effect.mapError((error) =>
        new TrackerFailed({ ticket, exitCode: 0, detail: `unparseable gh issue view output: ${error.message}` })
      )
    )
  })

/**
 * Fetches the ticket and writes it once to `<runRoot>/ticket.md`, the immutable artifact every
 * later node reads and every prompt cites by path (`runtime/ticket.ts`). No node changes the file
 * afterwards, and a resumed run replays this node from the journal, so the file it wrote stands.
 *
 * `input.maintainer` is caller-supplied, not resolved here: a credential lookup would name whoever
 * runs the pipeline, not the maintainer.
 */
export const fetchTicket = make({
  name: "fetch-ticket",
  description: "Fetch a ticket's maintainer-authored title, body and comments from the tracker into the run root.",
  input: Schema.Struct({ ticket: Schema.String, maintainer: Schema.String }),
  success: Schema.Struct({ ticket: Schema.String, title: Schema.String, ticketPath: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const ticketPath = `${runInfo.runRoot}/ticket.md`
      // Checked before the tracker is asked: a run with no run directory is a wiring bug, not a data problem.
      yield* requireRunRoot(() => new TicketWriteFailed({ ticket: input.ticket, path: ticketPath, detail: "run root missing" }))

      const issue = yield* fetchIssue(input.ticket)

      // A foreign-authored issue has no maintainer text to keep, so refuse before rendering.
      if (issue.author.login !== input.maintainer) {
        return yield* Effect.fail(new TicketNotMaintainerAuthored({ ticket: input.ticket }))
      }
      const title = issue.title.trim()
      if (title === "") return yield* Effect.fail(new EmptyTicket({ ticket: input.ticket }))

      const fs = yield* FileSystem.FileSystem
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(runInfo.runRoot, { recursive: true })
        yield* fs.writeFileString(ticketPath, [`# ${title}`, "", renderBody(issue, input.maintainer)].join("\n"))
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(new TicketWriteFailed({ ticket: input.ticket, path: ticketPath, detail: String(error) }))
        )
      )

      return { ticket: input.ticket, title, ticketPath }
    }).pipe(Effect.provide(platform))
})
