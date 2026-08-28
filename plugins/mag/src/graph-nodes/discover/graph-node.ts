import { Effect, FileSystem, Schema } from "effect"
import { DiscoverCommitFailed, DiscoverCopyFailed, DiscoverNoteMissing } from "mag/graph-nodes/discover/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { record, requireRunRoot } from "mag/runtime/records"
import { recordPath, RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"
import { TICKET_TOKEN } from "mag/skills/design/tokens"
import { compileRecon, DISCOVER_DESTINATION } from "mag/skills/recon"

/**
 * What the agent must return: the note's own path, per `design`'s `DESIGN` precedent — the
 * artifact travels back as a reference, not prose. Never trusted — the success carries the path
 * this node computed, not the session's echo of it.
 */
const VERDICT = verdictSchema(Schema.Struct({ discoverPath: Schema.String }))

/**
 * The whole brief. No vision, no design text — the input schema
 * carries neither, so that parallelism is a property of the schema, not a promise kept here.
 */
const promptFor = (
  input: { readonly ticket: string; readonly title: string; readonly ticketPath: string },
  notePath: string
): string =>
  [
    ...ticketReference(input),
    "",
    "Recon this repository for what this ticket touches. Read only.",
    `Write your findings to \`${notePath}\`. Change nothing else.`,
    "",
    compileRecon()
  ].join("\n")

/**
 * A commit, node-authored, one `Claude-Session` trailer per session — `simplify/graph-node.ts`'s
 * `commitMessageFor` precedent: the agent produces the change, the node makes the commit.
 */
const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `docs(${ticket}): discover`,
    "",
    "The discover node ran a read-only recon session and committed its findings note.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * One read-only recon session per ticket, driven by the ticket alone, writing
 * `docs/graph/<ticket>/discover.md`. Envision answers what the ideal shape looks like, discover
 * answers what currently exists, two independent questions answerable side by side. The node checks the note, copies it into the run root, and commits the repo copy only
 * when this repository's own policy says so (`RunInfoService.records`, `records.ts`).
 *
 * The check and the commit both use this node's own computed path, never the model's echo of it.
 */
export const discover = make({
  name: "discover",
  description: "Recon what a ticket's terrain already contains, as a cited note.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    /** A named agent to run the session as, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    discoverPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      // Single home for the note's path is `DISCOVER_DESTINATION` (`mag/skills/recon`), composed
      // through `recordPath`. The session still dispatches at `workdir(runInfo)`, because recon
      // must happen where the code is; only the note's destination and its commit follow the
      // records root.
      const notePath = recordPath(runInfo, DISCOVER_DESTINATION.replaceAll(TICKET_TOKEN, input.ticket))
      // A run with no run directory is a wiring bug, not a data problem — `design`'s own
      // `DesignRunRootMissing` pre-check, mapped onto this node's existing copy-failure tag.
      // `record` catches the same fact below, but only after a session has already been paid for.
      yield* requireRunRoot(() => new DiscoverCopyFailed({ path: notePath, detail: "run root missing", sessions: [] }))

      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(notePath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: promptFor(input, notePath),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      yield* record(notePath, {
        before,
        message: commitMessageFor(input.ticket, reply.sessions),
        sessions: reply.sessions,
        onMissing: (fields) => new DiscoverNoteMissing(fields),
        onCopyFailed: (fields) => new DiscoverCopyFailed(fields),
        onGitFailure: (fields) => new DiscoverCommitFailed({ ...fields, sessions: reply.sessions }),
        onCommitFailure: (fields) => new DiscoverCommitFailed(fields)
      })

      return { discoverPath: notePath, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
