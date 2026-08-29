import { Effect, FileSystem, Schema } from "effect"
import { BrainstormCommitFailed, BrainstormCopyFailed, BrainstormGitFailed, DesignMissing } from "mag/graph-nodes/brainstorm/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { gitRead } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { record, requireRunRoot } from "mag/runtime/records"
import { recordPath, RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"
import { SKILLS_TOKEN, TICKET_TOKEN } from "mag/skills/design/tokens"
import { DESIGN_DESTINATION, designDestinationFor } from "mag/skills/design/write-and-confirm"
import { SKILLS_ROOT } from "mag/skills/installed"

/** What the agent must return: `design/graph-node.ts`'s `DESIGN`
 * precedent — the artifact travels back as a path, not prose. Never trusted — the
 * success carries the path this node computed, not the session's echo of it. */
const VERDICT = verdictSchema(Schema.Struct({ designPath: Schema.String }))

/**
 * Frames the ticket, cites every vision and the discover note by path — read-only references, never
 * inlined, since artifacts travel as references and an oversized
 * prompt dies at execve — and appends the already-composed, already-budget-checked brainstorm
 * prompt (`assemble-brainstorm-prompt`'s own job; nothing here re-measures it). `composeDesignPrompt`
 * leaves `<TICKET>`/`<SKILLS>` unfilled by design ("so a consuming node can compose inside its own
 * runtime and fill the tokens itself", `compose.ts`'s own doc comment) — `assemble-brainstorm-prompt`
 * takes no `ticket` (its input is `{}`) and structurally cannot fill either token, so
 * this is the one node in the pipeline that can.
 */
const promptFor = (
  input: {
    readonly ticket: string
    readonly title: string
    readonly ticketPath: string
    readonly visionPaths: readonly string[]
    readonly discoverPath: string
    readonly recycleMapPath: string
    readonly prompt: string
  },
  designPath: string
): string =>
  [
    ...ticketReference(input),
    "",
    "Read each vision below, the discover note and the recycle map as citations. Do not redraw a vision or re-run recon.",
    ...input.visionPaths.map((path) => `- ${path}`),
    `- ${input.discoverPath}`,
    `- ${input.recycleMapPath}`,
    "",
    // `input.prompt` is opaque data from a sibling node (`assemble-brainstorm-prompt`'s
    // success), not text this node composes itself — unlike `design/graph-node.ts`'s `skillFor`,
    // which owns its own composition and can rely on `DESIGN_DESTINATION` being exactly what it put
    // there. This line is the structural guarantee that survives regardless of what `input.prompt`
    // actually contains (proven by `brainstorm/graph-node.test.ts`'s own token-filling test, which
    // hands in a synthetic prompt carrying neither `DESIGN_DESTINATION` nor a real write step).
    `Write the design doc to \`${designPath}\`, this run's own destination for it.`,
    "",
    // When `input.prompt` IS the real compiled skill (every live dispatch), this collapses its
    // write step onto the same absolute path stated above, so the two lines agree instead of
    // leaving the model to choose between a relative default and an override.
    input.prompt
      .replaceAll(DESIGN_DESTINATION, designPath)
      .replaceAll(TICKET_TOKEN, input.ticket)
      .replaceAll(SKILLS_TOKEN, SKILLS_ROOT)
  ].join("\n")

/** `discover`'s own `commitMessageFor` shape: `docs(<ticket>):
 * <artifact>` subject plus one `Claude-Session` trailer per session. */
const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `docs(${ticket}): design`,
    "",
    "The brainstorm node reconciled the visions with discover's recon and committed the design doc.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * The one design dispatch over the drawn visions and the recon. `records.ts`'s `record` own spine:
 * snapshot `before` → dispatch → verify the written document against it, copy it into the run
 * root, and commit the repo copy only when this repository's own policy says so (`record`,
 * `records.ts`) → `git rev-parse HEAD` for `headSha`. `write-and-confirm` tells the session not to
 * run git itself (`write-and-confirm.ts`'s `confirmStep`): the node is the one place that checks,
 * copies, and (conditionally) commits, for every writer alike.
 */
export const brainstorm = make({
  name: "brainstorm",
  description: "Reconcile the drawn visions with discover's recon, write design.md, stamp headSha.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    /** The already-composed, already-budget-checked brainstorm prompt (`assemble-brainstorm-prompt`'s success). */
    prompt: Schema.String,
    visionPaths: Schema.Array(Schema.String),
    discoverPath: Schema.String,
    recycleMapPath: Schema.String,
    /** A named agent to run the session as, same convention as `discover`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    designPath: Schema.String,
    /** HEAD of the tree the session worked in (`workdir(runInfo)`), meaningful under every records
     * policy — under the default `run-root` policy `recordsDir(runInfo)` is a plain OS temp
     * directory with no git repository of its own, so `recordsDir` cannot answer this. */
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      // The record's placement is `run-layers.ts`'s decision, read back through `recordPath`.
      const designPath = recordPath(runInfo, designDestinationFor(input.ticket))
      // A run with no run directory is a wiring bug, not a data problem — `design`'s own
      // `DesignRunRootMissing` pre-check, mapped onto this node's existing copy-failure tag.
      // `record` catches the same fact below, but only after a session has already been paid for.
      yield* requireRunRoot(() => new BrainstormCopyFailed({ path: designPath, detail: "run root missing", sessions: [] }))

      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(designPath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: promptFor(input, designPath),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      yield* record(designPath, {
        before,
        message: commitMessageFor(input.ticket, reply.sessions),
        sessions: reply.sessions,
        onMissing: (fields) => new DesignMissing(fields),
        onCopyFailed: (fields) => new BrainstormCopyFailed(fields),
        onGitFailure: (fields) => new BrainstormGitFailed(fields),
        onCommitFailure: (fields) => new BrainstormCommitFailed(fields)
      })

      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new BrainstormGitFailed(fields))
      return { designPath, headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
