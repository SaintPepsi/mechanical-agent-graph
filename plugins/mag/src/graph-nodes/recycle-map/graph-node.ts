import { Effect, FileSystem, Schema } from "effect"
import { RecycleMapCommitFailed, RecycleMapCopyFailed, RecycleMapMissing } from "mag/graph-nodes/recycle-map/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { record, requireRunRoot } from "mag/runtime/records"
import { recordPath, RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"
import { TICKET_TOKEN } from "mag/skills/design/tokens"
import { compileRecycleMap, RECYCLE_MAP_DESTINATION } from "mag/skills/recycle-map"

/** What the agent must return: the map's own path, `discover`'s precedent. Never trusted: the success carries the path this node computed. */
const VERDICT = verdictSchema(Schema.Struct({ recycleMapPath: Schema.String }))

/** The whole brief: the ticket and the discover note by path, the write line, the standard. */
const promptFor = (
  input: { readonly ticket: string; readonly title: string; readonly ticketPath: string; readonly discoverPath: string },
  mapPath: string
): string =>
  [
    ...ticketReference(input),
    `Read the discover note at \`${input.discoverPath}\`.`,
    "",
    "Map what this ticket can reuse in this repository. Read only.",
    `Write the map to \`${mapPath}\`. Change nothing else.`,
    "",
    compileRecycleMap()
  ].join("\n")

/** `discover`'s own `commitMessageFor` shape: one `Claude-Session` trailer per session. */
const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `docs(${ticket}): recycle-map`,
    "",
    "The recycle-map node ran a read-only reuse session and committed its map.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * One read-only reuse session per ticket, after `discover`: the map answers what already exists
 * that the ticket can reuse, reading the discover note by path, and writes
 * `docs/graph/<ticket>/recycle-map.md`. The dispatch spine is `discover`'s own (`records.ts`'s
 * `record`): the node checks the map, copies it into the run root, and commits the repo copy only
 * when this repository's own policy says so. The check and the commit use this node's own
 * computed path, never the model's echo of it.
 */
export const recycleMap = make({
  name: "recycle-map",
  description: "Map what already exists that a ticket can reuse, as a cited note after discover.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    discoverPath: Schema.String,
    /** A named agent to run the session as, same convention as `discover`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    recycleMapPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      const mapPath = recordPath(runInfo, RECYCLE_MAP_DESTINATION.replaceAll(TICKET_TOKEN, input.ticket))
      // A run with no run directory is a wiring bug, checked before a session is paid for.
      yield* requireRunRoot(() => new RecycleMapCopyFailed({ path: mapPath, detail: "run root missing", sessions: [] }))

      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(mapPath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: promptFor(input, mapPath),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      yield* record(mapPath, {
        before,
        message: commitMessageFor(input.ticket, reply.sessions),
        sessions: reply.sessions,
        onMissing: (fields) => new RecycleMapMissing(fields),
        onCopyFailed: (fields) => new RecycleMapCopyFailed(fields),
        onGitFailure: (fields) => new RecycleMapCommitFailed({ ...fields, sessions: reply.sessions }),
        onCommitFailure: (fields) => new RecycleMapCommitFailed(fields)
      })

      return { recycleMapPath: mapPath, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
