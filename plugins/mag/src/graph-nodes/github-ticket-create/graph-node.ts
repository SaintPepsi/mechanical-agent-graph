import { Effect, FileSystem, Schema } from "effect"
import {
  TicketBodyUnwritable,
  TicketDraftMissing,
  TicketDraftOffSchema,
  TicketFilingRejected,
  TicketTrackerUnreachable
} from "mag/graph-nodes/github-ticket-create/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"
import { renderTicketBody } from "mag/skills/ticket/render"
import { TicketSchema } from "mag/skills/ticket/schema"

/** `gh`'s own documented exits (`gh help exit-codes`), mapped onto tags — `comment-ticket`'s `failureFor` precedent. */
const failureFor = (exitCode: number, stderr: string, bodyPath: string) => {
  const detail = stderr.trim()
  if (exitCode === 4) return new TicketTrackerUnreachable({ detail })
  return new TicketFilingRejected({ exitCode, detail, bodyPath })
}

/** The ticket draft at `path`, read and decoded — a file is a trust boundary (`analyse-reviews`'s `readManifest` precedent), so a draft the two nodes disagree about the schema of fails here, named, not as a garbled `gh` argument. `fromJsonString` carries the parse itself, so unreadable, unparseable and off-schema are one rail rather than three copies of the same failure. */
const readTicket = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TicketSchema))),
    Effect.catch((error) => Effect.fail(new TicketDraftOffSchema({ path, detail: String(error) })))
  )

/**
 * The mechanical half of `ticket-writer`: renders the house body from a
 * validated `Ticket`, files it with `gh`, returns the URL. No model-dispatch service appears in this
 * node's closure, so "dispatches no model session" is a fact about the code
 * rather than a claim a test has to take on faith.
 *
 * Every failure after the render leaves the rendered body on disk:
 * nothing here is retried and nothing is caught past that point, so a rejected filing is the
 * caller's edge, with a pasteable draft waiting for it.
 */
export const githubTicketCreate = make({
  name: "github-ticket-create",
  description: "File a validated ticket structure as a GitHub issue: render the body, gh issue create, return the URL.",
  input: Schema.Struct({ ticketPath: Schema.String }),
  success: Schema.Struct({
    issueUrl: Schema.String,
    title: Schema.String,
    bodyPath: Schema.String
  }),
  run: (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      if (!(yield* fs.exists(input.ticketPath))) {
        return yield* Effect.fail(new TicketDraftMissing({ path: input.ticketPath }))
      }

      const ticket = yield* readTicket(fs, input.ticketPath)

      const runInfo = yield* RunInfo
      const bodyPath = yield* writeArtifact(fs, runInfo.runRoot, "ticket-body", renderTicketBody(ticket)).pipe(
        Effect.catch((error) => Effect.fail(new TicketBodyUnwritable({ runRoot: runInfo.runRoot, detail: String(error) })))
      )

      const shell = yield* Shell
      const result = yield* shell.run(["gh", "issue", "create", "--title", ticket.title, "--body-file", bodyPath])
      if (result.exitCode !== 0) {
        return yield* Effect.fail(failureFor(result.exitCode, result.stderr, bodyPath))
      }

      return { issueUrl: result.stdout.trim(), title: ticket.title, bodyPath }
    }).pipe(Effect.provide(platform))
})
