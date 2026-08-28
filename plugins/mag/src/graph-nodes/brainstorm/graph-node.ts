import { Effect, FileSystem, Schema } from "effect"
import {
  BrainstormCommitFailed,
  BrainstormCopyFailed,
  BrainstormGitFailed,
  BrainstormResumeEmpty,
  DesignMissing
} from "mag/graph-nodes/brainstorm/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { gitRead } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { record, requireRunRoot } from "mag/runtime/records"
import { declaredRulings, rulingsBlock } from "mag/runtime/rulings"
import { recordPath, RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"
import { SKILLS_TOKEN, TICKET_TOKEN } from "mag/skills/design/tokens"
import { DESIGN_DESTINATION, designDestinationFor } from "mag/skills/design/write-and-confirm"
import { SKILLS_ROOT } from "mag/skills/installed"

/**
 * What the agent must return: `design/graph-node.ts`'s `DESIGN` precedent — the artifact travels
 * back as a path, never trusted. `dispute` is `optionalKey`, `build`'s reasoning: `optional` would
 * show the model a nullable union on every ordinary pass, inviting an explicit null.
 */
const VERDICT = verdictSchema(Schema.Struct({ designPath: Schema.String, dispute: Schema.optionalKey(Schema.String) }))

/** `build`'s `sendBackBlock`, addressed to the design's author: findings are claims to answer, never to accept on faith. */
const sendBackBlock = (findingsPath: string, designPath: string): readonly string[] => [
  "A reviewer examined this design and its plan and found blocking problems, recorded at",
  `${findingsPath}. Read that file and address every finding: rewrite the design at \`${designPath}\``,
  "in place for each one that needs a change, and for any that need none — already answered, or",
  "wrong — say why in your reply's `dispute` field instead of inventing a change to satisfy it. A",
  "single pass may change the design and dispute the rest.",
  "A finding that quotes a rulings file the ticket itself contradicts is disputed, not fixed."
]

/**
 * A first pass frames the ticket, cites every vision, the discover note and the recycle map by
 * path — read-only references, never inlined, since an oversized prompt dies at execve — names
 * the repository's own rulings files, the same list `review-plan` will hold the design to, and
 * appends the already-composed, already-budget-checked brainstorm prompt
 * (`assemble-brainstorm-prompt`'s own job). `composeDesignPrompt` leaves `<TICKET>`/`<SKILLS>`
 * unfilled by design, and this is the one node in the pipeline that can fill them. A resumed pass
 * drops the citations and the compiled skill — the session already holds them, and restating them
 * invites a redesign from scratch — and carries the ticket reference plus the send-back alone, so
 * the session can still reopen the ticket the findings are judged against.
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
    readonly findingsPath?: string | undefined
    readonly resume?: string | undefined
  },
  designPath: string,
  rulings: readonly string[]
): string =>
  input.resume !== undefined && input.findingsPath !== undefined
    ? [...ticketReference(input), "", ...sendBackBlock(input.findingsPath, designPath)].join("\n")
    : [
      ...ticketReference(input),
      "",
      "Read each vision below, the discover note and the recycle map as citations. Do not redraw a vision or re-run recon.",
      ...input.visionPaths.map((path) => `- ${path}`),
      `- ${input.discoverPath}`,
      `- ${input.recycleMapPath}`,
      ...rulingsBlock(rulings),
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
        .replaceAll(SKILLS_TOKEN, SKILLS_ROOT),
      ...(input.findingsPath === undefined ? [] : ["", ...sendBackBlock(input.findingsPath, designPath)])
    ].join("\n")

/** `discover`'s own `commitMessageFor` shape: `docs(<ticket>): <artifact>` plus one `Claude-Session` trailer per session. */
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
 * root, and commit the repo copy only when this repository's own policy says so → `git rev-parse
 * HEAD` for `headSha`. `write-and-confirm` tells the session not to run git itself: the node is the
 * one place that checks, copies, and (conditionally) commits, for every writer alike.
 *
 * A send-back pass (`findingsPath` present) may answer with a dispute instead of a change: the
 * design unchanged from its snapshot plus a non-empty `dispute` is a filed `dispute-N.md` and an
 * ordinary success carrying both paths, `build`'s own dispute edge; unchanged and silent stays
 * {@link DesignMissing}. A changed design files the dispute too, when one is given.
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
    /** The blocking verdict this pass is answering (`review-plan`'s findings). Present means a send-back pass: the prompt names the file, and an unchanged design may end in a dispute. */
    findingsPath: Schema.optional(Schema.String),
    /** The session this pass resumes, `build`'s convention: the prompt drops the citations and the compiled skill, which the session already holds. */
    resume: Schema.optional(Schema.String),
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
    costUsd: Schema.NullOr(Schema.Number),
    /** Present together: the findings this pass answered and the dispute it filed. */
    findingsPath: Schema.optional(Schema.String),
    disputePath: Schema.optional(Schema.String),
    /** The pinned session id, `reply.sessions[0]`, for a caller that resumes this pass on a send-back. */
    sessionRef: Schema.String,
    /** Whether this pass rewrote the design: `false` only on a dispute-only send-back, where the plan over it needs no rewrite either. */
    changed: Schema.Boolean
  }),
  run: (input) =>
    Effect.gen(function* () {
      if (input.resume !== undefined && input.findingsPath === undefined) {
        return yield* Effect.fail(new BrainstormResumeEmpty())
      }
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      // The record's placement is `run-layers.ts`'s decision, read back through `recordPath`.
      const designPath = recordPath(runInfo, designDestinationFor(input.ticket))
      // A run with no run directory is a wiring bug, not a data problem; `record` catches the same
      // fact below, but only after a session has already been paid for.
      yield* requireRunRoot(() => new BrainstormCopyFailed({ path: designPath, detail: "run root missing", sessions: [] }))

      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(designPath).pipe(Effect.catch(() => Effect.succeed("")))

      // A resumed session already holds the list; reading it again would only cost a git call.
      const rulings = input.resume === undefined
        ? yield* declaredRulings(cwd, (fields) => new BrainstormGitFailed(fields))
        : []

      const reply = yield* agent.prompt({
        prompt: promptFor(input, designPath, rulings),
        jsonSchema: VERDICT,
        cwd,
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const disputed = input.findingsPath !== undefined && reply.verdict.dispute !== undefined && reply.verdict.dispute.trim() !== ""
      const written = yield* fs.readFileString(designPath).pipe(Effect.catch(() => Effect.succeed("")))
      // A disputing pass that changed nothing is answered, not missing: the previous pass's record
      // stands, on disk and in the run root, so nothing is re-verified or re-copied.
      if (!(disputed && written === before)) {
        yield* record(designPath, {
          before,
          message: commitMessageFor(input.ticket, reply.sessions),
          sessions: reply.sessions,
          onMissing: (fields) => new DesignMissing(fields),
          onCopyFailed: (fields) => new BrainstormCopyFailed(fields),
          onGitFailure: (fields) => new BrainstormGitFailed(fields),
          onCommitFailure: (fields) => new BrainstormCommitFailed(fields)
        })
      }

      const dispute = !disputed || input.findingsPath === undefined ? {} : {
        findingsPath: input.findingsPath,
        disputePath: yield* writeArtifact(fs, runInfo.runRoot, "dispute", [`Disputes ${input.findingsPath}`, "", reply.verdict.dispute].join("\n")).pipe(
          Effect.catch((error) =>
            Effect.fail(new BrainstormCopyFailed({ path: runInfo.runRoot, detail: String(error), sessions: reply.sessions }))
          )
        )
      }

      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new BrainstormGitFailed(fields))
      return { designPath, headSha, sessions: reply.sessions, costUsd: reply.costUsd, sessionRef: reply.sessions[0]!, changed: written !== before, ...dispute }
    }).pipe(Effect.provide(platform))
})
