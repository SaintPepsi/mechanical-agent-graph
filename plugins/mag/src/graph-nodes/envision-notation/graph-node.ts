import { Effect, FileSystem, Result, Schema } from "effect"
import {
  NotationVisionBlocked,
  NotationVisionCommitFailed,
  NotationVisionCopyFailed,
  NotationVisionGitFailed,
  NotationVisionMissing,
  UnknownNotation
} from "mag/graph-nodes/envision-notation/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { record, requireRunRoot } from "mag/runtime/records"
import { recordPath, RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"
import { NOTATIONS } from "mag/skills/design/envisioning"
import { compileEnvisionNotation, visionDestination } from "mag/skills/envision/notation"

/**
 * What the session must return: `build`'s dispute idiom (`Schema.optionalKey`, not `optional` —
 * `anyOf: [string, null]` on every ordinary pass would invite an explicit null where there is
 * nothing to say). `visionPath` is echoed and ignored, `envision-mermaid`'s own precedent: the
 * node checks its own computed path, never the model's claim of it. A present
 * `blocked` is the session declaring its own failure, this node's mechanism for "trust a declared
 * failure".
 */
const VISION = verdictSchema(Schema.Struct({ visionPath: Schema.String, blocked: Schema.optionalKey(Schema.String) }))

/** `discover`'s own `promptFor` shape: ticket framing, then the compiled discipline — no vision or
 * design text in the input schema to leak in. */
const promptFor = (input: { readonly ticket: string; readonly title: string; readonly ticketPath: string }, compiled: string): string =>
  [...ticketReference(input), "", compiled].join("\n")

const messageFor = (ticket: string, notation: string, sessions: readonly string[]): string =>
  [
    `docs(${ticket}): vision-${notation}`,
    "",
    `envision-notation drew the ${notation} vision and committed it.`,
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * One notation, dispatched, checked and copied by one node — this node's whole point.
 * `notation` is `Schema.String`, not a literal union, so this node
 * registers (`schema-flags.ts` derives flags for string/number/boolean only); the closed set is
 * enforced by `compileEnvisionNotation`, which resolves through `concernForNotation`
 * (`skills/design/envisioning.ts`'s one home for the id-to-module map) and fails before any session
 * dispatches.
 *
 * The dispatch spine, `records.ts`'s `record` own: compute the destination this node owns → snapshot
 * `before` → dispatch → trust a declared `blocked` immediately, no disk read, no copy, no commit →
 * verify the written document against the snapshot, copy it into the run root, and commit the repo
 * copy only when this repository's own policy says so (`record`, `records.ts`).
 */
export const envisionNotation = make({
  name: "envision-notation",
  description: "Draw one notation's ideal vision, blind to the repo.",
  input: Schema.Struct({
    notation: Schema.String,
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    /** A named agent to run the session as, same convention as `discover`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    notation: Schema.String,
    /** The concern id this dispatch composed, distinct from `notation` (svelte → envision-svelte) —
     * the provenance this module's assembly checks, reported at the site where envisioning now happens. */
    module: Schema.String,
    visionPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      // Composed through `recordPath`, not `workRoot` directly. The session still dispatches
      // at `workdir(runInfo)`; only the vision's destination and its commit follow the records root.
      const visionPath = recordPath(runInfo, visionDestination(input.ticket, input.notation))
      // A run with no run directory is a wiring bug, not a data problem — `design`'s own
      // `DesignRunRootMissing` pre-check, mapped onto this node's existing copy-failure tag.
      // `record` catches the same fact below, but only after a session has already been paid for.
      yield* requireRunRoot(
        () => new NotationVisionCopyFailed({ path: visionPath, detail: "run root missing", sessions: [] })
      )

      const compiled = compileEnvisionNotation({ notation: input.notation, destination: visionPath })
      if (Result.isFailure(compiled)) {
        return yield* Effect.fail(new UnknownNotation({ notation: input.notation, known: NOTATIONS }))
      }

      const agent = yield* ClaudeAgent
      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(visionPath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: promptFor(input, compiled.success.prompt),
        jsonSchema: VISION,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      if (reply.verdict.blocked !== undefined) {
        // The declared reason is the only artifact this dispatch produced, so it lands in the run
        // root before the failure carries its path; a failed write is a run-root write failure like any other.
        const reasonPath = yield* writeArtifact(fs, runInfo.runRoot, "vision-blocked", reply.verdict.blocked).pipe(
          Effect.catch((error) =>
            Effect.fail(new NotationVisionCopyFailed({ path: runInfo.runRoot, detail: String(error), sessions: reply.sessions }))
          )
        )
        return yield* Effect.fail(new NotationVisionBlocked({ notation: input.notation, reasonPath, sessions: reply.sessions }))
      }

      yield* record(visionPath, {
        before,
        message: messageFor(input.ticket, input.notation, reply.sessions),
        sessions: reply.sessions,
        onMissing: (fields) => new NotationVisionMissing({ notation: input.notation, ...fields }),
        onCopyFailed: (fields) => new NotationVisionCopyFailed(fields),
        onGitFailure: (fields) => new NotationVisionGitFailed(fields),
        onCommitFailure: (fields) => new NotationVisionCommitFailed(fields)
      })

      return { notation: input.notation, module: compiled.success.module, visionPath, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
