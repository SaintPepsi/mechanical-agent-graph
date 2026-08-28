import { Effect, FileSystem, Schema } from "effect"
import { PlanCommitFailed, PlanCopyFailed, PlanGitFailed, PlanMissing } from "mag/graph-nodes/plan/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { gitRead } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { record, requireRunRoot } from "mag/runtime/records"
import { recordPath, RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"
import { TICKET_TOKEN } from "mag/skills/design/tokens"
import { compilePlan, PLAN_DESTINATION, PLAN_PARAMS } from "mag/skills/plan"

/** What the agent must return: the plan's own path, `brainstorm`'s `designPath` precedent. Never trusted — the success carries the path this node computed. */
const VERDICT = verdictSchema(Schema.Struct({ planPath: Schema.String }))

/**
 * Frames the ticket, cites the design, the discover note and the recycle map by path — read-only
 * references, never inlined, since an oversized prompt dies at execve — names this run's own
 * destination for the plan, and splices the compiled plan standard.
 */
const promptFor = (
  input: {
    readonly ticket: string
    readonly title: string
    readonly ticketPath: string
    readonly designPath: string
    readonly discoverPath: string
    readonly recycleMapPath: string
  },
  planPath: string
): string =>
  [
    ...ticketReference(input),
    "",
    "Read the design below, the discover note and the recycle map as citations. Plan the build the design describes, as it stands.",
    `- ${input.designPath}`,
    `- ${input.discoverPath}`,
    `- ${input.recycleMapPath}`,
    "",
    `Write the plan to \`${planPath}\`, this run's own destination for it.`,
    "",
    compilePlan(PLAN_PARAMS)
  ].join("\n")

/** `brainstorm`'s own `commitMessageFor` shape: `docs(<ticket>): <artifact>` plus one `Claude-Session` trailer per session. */
const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `docs(${ticket}): plan`,
    "",
    "The plan node turned the design into an ordered task list and committed the plan.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * One plan session over the design and the recon. `brainstorm`'s spine with a different prompt
 * and destination: snapshot `before` → dispatch → `record` (verify against the snapshot, copy into
 * the run root, commit only under `records: "committed"`) → `git rev-parse HEAD` for `headSha`.
 */
export const plan = make({
  name: "plan",
  description: "Turn the design into an ordered task list, write plan.md, stamp headSha.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    designPath: Schema.String,
    discoverPath: Schema.String,
    recycleMapPath: Schema.String,
    /** A named agent to run the session as, same convention as `brainstorm`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    planPath: Schema.String,
    /** HEAD of the tree the session worked in (`workdir(runInfo)`), `brainstorm`'s own field for the same reason. */
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      const planPath = recordPath(runInfo, PLAN_DESTINATION.replaceAll(TICKET_TOKEN, input.ticket))
      yield* requireRunRoot(() => new PlanCopyFailed({ path: planPath, detail: "run root missing", sessions: [] }))

      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(planPath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: promptFor(input, planPath),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      yield* record(planPath, {
        before,
        message: commitMessageFor(input.ticket, reply.sessions),
        sessions: reply.sessions,
        onMissing: (fields) => new PlanMissing(fields),
        onCopyFailed: (fields) => new PlanCopyFailed(fields),
        onGitFailure: (fields) => new PlanGitFailed(fields),
        onCommitFailure: (fields) => new PlanCommitFailed(fields)
      })

      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new PlanGitFailed(fields))
      return { planPath, headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
