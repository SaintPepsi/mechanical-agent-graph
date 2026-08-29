import { Effect, FileSystem, Result, Schema } from "effect"
import { ShellBlocked, ShellMissing, ShellReasonWriteFailed, ShellRunRootMissing, UnknownNotation } from "mag/graph-nodes/envision-shell/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { requireRunRoot } from "mag/runtime/records"
import { recordPath, RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"
import { designDestinationFor } from "mag/skills/design/write-and-confirm"
import { NOTATIONS, notationsFor } from "mag/skills/design/envisioning"
import { compileEnvisionShell } from "mag/skills/envision/notation"

/**
 * What the session must return: `build`'s dispute idiom (`Schema.optionalKey`, not `optional`,
 * since `anyOf: [string, null]` on every ordinary pass would invite an explicit null where there is
 * nothing to say). `designPath` is echoed and ignored, `envision-mermaid`'s own precedent: the
 * node checks its own computed path, never the model's claim of it. A present `blocked` is the
 * session declaring its own failure, this node's mechanism for "trust a declared failure".
 */
const VISION = verdictSchema(Schema.Struct({ designPath: Schema.String, blocked: Schema.optionalKey(Schema.String) }))

/** `discover`'s own `promptFor` shape: ticket framing, then the compiled discipline. The input schema carries no discover note, so the pass is blind by construction, not by prose. */
const promptFor = (input: { readonly ticket: string; readonly title: string; readonly ticketPath: string }, compiled: string): string =>
  [...ticketReference(input), "", compiled].join("\n")

/**
 * The first prompt of the design session: the Envisioned Shell, drawn blind, one per matched
 * notation, into the design doc alone. Blindness is mechanical: this schema cannot name the
 * discover note, so the shell is drawn before any recon can reach the session. The session it
 * opens is the one `brainstorm` resumes to complete the design (`sessionRef`): the shell and the
 * design that grows around it are one session's work, which is what spares the design a
 * reconciliation section joining separately drawn visions to a separately written design. On the
 * two trial runs that section cost a nine-row table and three invented nodes; the shell as a
 * section of the design cost neither.
 *
 * `notations` is the matched stacks; none resolves to the generic notation (`notationsFor`, an
 * answer, not an error), and an id no module answers to fails {@link UnknownNotation} before any
 * session dispatches. The dispatch spine is `envision-mermaid`'s: snapshot `before`, dispatch,
 * trust a declared `blocked` immediately (no disk read), else verify the written document against
 * the snapshot. No copy and no commit here: `brainstorm` records the completed design once.
 */
export const envisionShell = make({
  name: "envision-shell",
  description: "Draw the design's Envisioned Shell blind to the repo, one shell per matched notation, opening the session the design pass resumes.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    /** The matched stack ids (`STACKS`); empty draws the generic notation. */
    notations: Schema.Array(Schema.String),
    /** A named agent to run the session as, same convention as `discover`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    designPath: Schema.String,
    /** The concern ids this dispatch composed, in `notations` order (svelte → envision-svelte): the provenance the assembly checks. */
    modules: Schema.Array(Schema.String),
    /** The pinned session id, `reply.sessions[0]`, for `brainstorm` to resume with the design pass. */
    sessionRef: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      // The record's placement is `run-layers.ts`'s decision, read back through `recordPath`; the
      // session still dispatches at `workdir(runInfo)`.
      const designPath = recordPath(runInfo, designDestinationFor(input.ticket))
      yield* requireRunRoot(() => new ShellRunRootMissing())

      const notations = notationsFor(input.notations)
      if (Result.isFailure(notations)) {
        return yield* Effect.fail(new UnknownNotation({ notation: notations.failure, known: NOTATIONS }))
      }
      const compiled = compileEnvisionShell({ notations: notations.success, destination: designPath })
      if (Result.isFailure(compiled)) {
        return yield* Effect.fail(new UnknownNotation({ notation: compiled.failure, known: NOTATIONS }))
      }

      const agent = yield* ClaudeAgent
      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(designPath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: promptFor(input, compiled.success.prompt),
        jsonSchema: VISION,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      if (reply.verdict.blocked !== undefined) {
        // The declared reason is the only artifact this dispatch produced, so it lands in the run
        // root before the failure carries its path.
        const reasonPath = yield* writeArtifact(fs, runInfo.runRoot, "vision-blocked", reply.verdict.blocked).pipe(
          Effect.catch((error) =>
            Effect.fail(new ShellReasonWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions }))
          )
        )
        return yield* Effect.fail(new ShellBlocked({ reasonPath, sessions: reply.sessions }))
      }

      const written = yield* fs.readFileString(designPath).pipe(Effect.catch(() => Effect.succeed("")))
      if (written.trim() === "" || written === before) {
        return yield* Effect.fail(new ShellMissing({ path: designPath, sessions: reply.sessions }))
      }

      return { designPath, modules: compiled.success.modules, sessionRef: reply.sessions[0]!, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
