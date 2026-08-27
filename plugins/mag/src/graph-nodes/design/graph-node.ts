import { Effect, FileSystem, Schema } from "effect"
import { DesignCopyFailed, DesignFileMissing, DesignGitFailed, DesignRunRootMissing } from "mag/graph-nodes/design/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { gitRead } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { record } from "mag/runtime/records"
import { recordPath, RunInfo, workdir } from "mag/runtime/run-info"
import { composeDesignPrompt } from "mag/skills/design/compose"
import { SKILLS_TOKEN, TICKET_TOKEN } from "mag/skills/design/tokens"
import { HEADLESS_DESIGN } from "mag/skills/design/variants"
import { DESIGN_DESTINATION, designDestinationFor } from "mag/skills/design/write-and-confirm"
import { SKILLS_ROOT } from "mag/skills/installed"

/** What the agent must return: the design.md reference, not the design text itself. */
const DESIGN = verdictSchema(Schema.Struct({ designPath: Schema.String }))

/**
 * Composes the headless design variant fresh at dispatch, inside this node's own runtime: not at
 * module load, and never materialized as a file. The agent is handed the composed text directly,
 * never told to go find a skill. `mag/skills/*` is a sanctioned `import-surface` seam: this
 * node's own directory isn't where the definition lives, and it doesn't need to be.
 * `HEADLESS_DESIGN` carries the core concerns only: none of hard-gate, clarifying-questions, or
 * dialogue-norms rides this dispatch. Fills the two dispatch-time tokens the composed text
 * carries, the run's ticket and this checkout's skills root — plus the write step's own
 * `DESIGN_DESTINATION` literal, which the compiled text still carries verbatim: replaced with this
 * run's resolved absolute path before either token fill, so a foreign run's dispatch cwd (the
 * target) never leaves the agent a relative default to fall back on — the same fix `brainstorm`'s
 * sibling copy of this problem uses.
 */
const skillFor = (ticket: string, designPath: string): string =>
  composeDesignPrompt(HEADLESS_DESIGN)
    .replaceAll(DESIGN_DESTINATION, designPath)
    .replaceAll(TICKET_TOKEN, ticket)
    .replaceAll(SKILLS_TOKEN, SKILLS_ROOT)

/**
 * The ticket reference plus the compiled brainstorming skill: no override clause, because
 * `skillFor` already substitutes this run's resolved path into the skill's own write step before
 * this text is assembled — the competing relative default never reaches the compiled text at all,
 * so there is nothing here left to out-argue it.
 */
const promptFor = (
  input: { readonly ticket: string; readonly title: string; readonly body: string },
  designPath: string
): string =>
  [
    `Ticket ${input.ticket}: ${input.title}`,
    "",
    input.body,
    "",
    "Apply the brainstorming skill below to this ticket, and reply with the design doc's path.",
    "",
    skillFor(input.ticket, designPath)
  ].join("\n")

/** `brainstorm`'s own `commitMessageFor` shape — the two lanes write the same artifact and must
 *  not disagree on what a commit of it says. */
const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `docs(${ticket}): design`,
    "",
    "The design node reconciled the ticket into a design doc and committed it.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * The registry-only single-session design node — one design session over the ticket before
 * anything is built, kept so a graph that does not compose `design-graph` can still produce a
 * design. The agent produces the artifact and the design travels back as a path,
 * not prose: the journal row carries a reference instead of a copy, and the design never rides a
 * later prompt's argv (an oversized prompt dies at execve).
 *
 * The artifact's home is the repository — `docs/graph/<ticket>/design.md` — and the node checks
 * it, copies it into the run root, and commits the repo copy only when this repository's own
 * policy says so (`record`, `records.ts`). The check and the copy use this node's own computed
 * path, never the model's echo of it.
 */
export const design = make({
  name: "design",
  description: "Brainstorm the ticket into a design the build step starts from.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    body: Schema.String,
    /** A named agent to run the session as, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    designPath: Schema.String,
    /** HEAD of the tree the session worked in (`workdir(runInfo)`), meaningful under every records
     * policy — under the default `run-root` policy `recordsDir(runInfo)` is a plain OS temp
     * directory with no git repository of its own, so `recordsDir` cannot answer this. For the
     * terseness evaluator to gate against. */
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new DesignRunRootMissing())
      const cwd = workdir(runInfo)
      // The design is a repository artifact, on a deterministic per-ticket path. Which repository
      // that commit lands in is `run-layers.ts`'s own decision, not this node's: the
      // sensitive-file guard that ruled out the run root is recorded there, and `recordPath`
      // resolves it. This node is registry-only today, composed the same way so the two lanes
      // cannot disagree (`design-graph`'s `brainstorm` is the live writer).
      const designPath = recordPath(runInfo, designDestinationFor(input.ticket))

      const fs = yield* FileSystem.FileSystem
      // A pre-dispatch snapshot, `brainstorm`'s own idiom: without it, a stale `design.md` left by a
      // previous run at this same path would pass `record`'s presence check as this session's own
      // output, even though the session never touched it.
      const before = yield* fs.readFileString(designPath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: promptFor(input, designPath),
        jsonSchema: DESIGN,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      yield* record(designPath, {
        before,
        message: commitMessageFor(input.ticket, reply.sessions),
        sessions: reply.sessions,
        onMissing: (fields) => new DesignFileMissing(fields),
        onCopyFailed: (fields) => new DesignCopyFailed(fields),
        // `DesignGitFailed`'s three-field shape fits both a failed `git add` and a failed `git
        // commit` the same way it already fits the `rev-parse` below — reused rather than minting
        // a tag carrying no new information (`brainstorm/errors.ts`'s own precedent for the reuse).
        onGitFailure: (fields) => new DesignGitFailed(fields),
        onCommitFailure: (fields) => new DesignGitFailed(fields)
      })

      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (info) => new DesignGitFailed(info))
      return { designPath, headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
