import { Effect, FileSystem, Schema } from "effect"
import { assembleBrainstormPrompt } from "mag/graph-nodes/assemble-brainstorm-prompt/graph-node"
import { designUnderReview } from "mag/graph-nodes/design-under-review/graph-node"
import { detectEffect } from "mag/graph-nodes/detect-effect/graph-node"
import { detectGraphCore } from "mag/graph-nodes/detect-graph-core/graph-node"
import { detectSvelte } from "mag/graph-nodes/detect-svelte/graph-node"
import { discover } from "mag/graph-nodes/discover/graph-node"
import { envisionShell } from "mag/graph-nodes/envision-shell/graph-node"
import { DesignGraphTicketUnreadable } from "mag/graphs/design-graph/errors"
import { graph } from "mag/runtime/graph"
import { platform } from "mag/runtime/platform"

// `graphs/develop-graph/graph.ts`'s own records-policy check, copied rather than shared: this graph and that one
// each own their own input schema, and a check hanging off a `Schema.String` is what lets
// `schema-flags.ts` still derive a CLI flag for it (that graph's own comment on the same line).
const RECORDS_POLICIES = ["run-root", "committed"] as const
type RecordsPolicy = (typeof RECORDS_POLICIES)[number]
// Pipeline policy, `graphs/develop-graph/graph.ts`'s `REVIEW_CAP` reasoning: one round per producer
// after the first (one design fix and one plan fix), then the findings escalate, a design still
// blocked after a full round is a ticket problem.
const PLAN_CAP = 1

const isRecordsPolicyCheck = Schema.makeFilter<string>(
  (value) => ((RECORDS_POLICIES as readonly string[]).includes(value) ? undefined : `expected ${RECORDS_POLICIES.join(" or ")}`),
  { expected: RECORDS_POLICIES.join(" or ") }
)

/** The three probes' matched stack ids, in probe order: `envision-shell`'s `notations`. The
 * successes carry more (`manifests`, the unmatched rows), read here down to the one fact the shell
 * pass needs, so the probes state their evidence once and the shell never sees it. */
const matchedStacks = (text: string) =>
  Effect.all([detectSvelte.run({ text }), detectEffect.run({ text }), detectGraphCore.run({ text })], { concurrency: "unbounded" }).pipe(
    Effect.map((verdicts) => verdicts.filter((verdict) => verdict.matched).map((verdict) => verdict.stack))
  )

/** Every route this graph dispatches reads the same ticket triple and the same optional agent
 * assignment, spelled once so `envisionShell`, `discover` and `designUnderReview`'s three calls
 * below cannot drift from each other. */
const ticketFields = (input: { readonly ticket: string; readonly title: string; readonly ticketPath: string }) => ({
  ticket: input.ticket,
  title: input.title,
  ticketPath: input.ticketPath
})
const agentFields = (input: { readonly agent?: string; readonly model?: string }) => ({
  ...(input.agent === undefined ? {} : { agent: input.agent }),
  ...(input.model === undefined ? {} : { model: input.model })
})

/**
 * The spine is **Envision ∥ Discover → Design under review**. The three probes run first and
 * decide which notations `envisionShell` draws; the shell pass, discovery and prompt assembly then
 * run side by side, and the reason `assembleBrainstormPrompt` rides along in the same `Effect.all`
 * even though nothing upstream feeds it: it has no dependency on the probes or the shell, so
 * waiting for them first would only cost wall-clock for no reason. The shell pass is blind by
 * schema (it cannot be handed the discover note) and by order (the note is still being written
 * while it draws); `designUnderReview` is the only node that reads every half: brainstorm resumes
 * the shell's own session over the discover note and completes the design in place, then
 * recycle-scan → plan → review-plan, each finding sent back to the session that owns the artifact
 * it names until clean.
 */
const pipeline = (input: {
  readonly ticket: string
  readonly title: string
  readonly ticketPath: string
  readonly agent?: string
  readonly model?: string
}) =>
  Effect.gen(function* () {
    // The probes match manifests against the ticket's own words, read here from the ticket file:
    // a file is a trust boundary, tagged the way `require-acs` tags the same read.
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(input.ticketPath).pipe(
      Effect.mapError((error) => new DesignGraphTicketUnreadable({ ticket: input.ticket, path: input.ticketPath, detail: String(error) }))
    )
    const notations = yield* matchedStacks(text)

    const [shell, discovered, assembled] = yield* Effect.all(
      [
        envisionShell.run({ notations, ...ticketFields(input), ...agentFields(input) }),
        discover.run({ ...ticketFields(input), ...agentFields(input) }),
        assembleBrainstormPrompt.run({})
      ],
      { concurrency: "unbounded" }
    )

    const designed = yield* designUnderReview.run({
      ...ticketFields(input),
      prompt: assembled.prompt,
      discoverPath: discovered.discoverPath,
      resume: shell.sessionRef,
      cap: PLAN_CAP,
      ...agentFields(input)
    })

    return {
      designPath: designed.designPath,
      planPath: designed.planPath,
      headSha: designed.headSha,
      discoverPath: discovered.discoverPath,
      sessions: [...shell.sessions, ...discovered.sessions, ...designed.sessions],
      // One unpriced session makes the run's figure unpriced, never silently zero, `graphs/develop-graph/graph.ts`'s own reduction.
      costUsd: [shell.costUsd, discovered.costUsd, designed.costUsd].reduce((a, b) => (a === null || b === null ? null : a + b))
    }
  }).pipe(Effect.provide(platform))

/**
 * design-graph: one GraphNode for the design lane, in the slot `develop-graph`'s host graph
 * composes it. Its success carries the reviewed plan beside the design: a build reads the plan. Its
 * folder holds the two visions (`graphs/design-graph/{vision,rail-sketch}.md`) beside the code they
 * shaped. `design` alone is not available: the registry is one flat namespace, and the standalone
 * `design` node (`graph-nodes/design`) already holds that name.
 *
 * Creates no branch, no worktree, no PR: it writes into the checkout it is handed, which is why
 * `worktree: false`: a host graph's already-minted scope wins by construction when this graph is
 * borrowed (`RunScoped`), the same reasoning `graphs/envision/graph.ts` already states for its own
 * `worktree: false`.
 *
 * The success is a superset of the existing `design` node's (`designPath`, `headSha`, `sessions`,
 * `costUsd`), which is what lets a future host graph swap one for the other without a shim.
 */
export const designGraph = graph({
  name: "design-graph",
  description: "Draw the shell blind in every matched stack's notation, discover what exists, complete the design around the shell, scan the repo for its names, plan it, and review both before any build.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    /** A named agent for every session this graph dispatches, same convention as `discover`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model` for every session this graph dispatches, same convention as `agent`. */
    model: Schema.optional(Schema.String),
    /** `"run-root"` or `"committed"` (`RunInfoService.records`'s own doc), `graphs/develop-graph/graph.ts`'s
     *  own field, same convention. */
    records: Schema.optional(Schema.String.check(isRecordsPolicyCheck))
  }),
  success: Schema.Struct({
    designPath: Schema.String,
    planPath: Schema.String,
    headSha: Schema.String,
    discoverPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  scope: (input) => ({
    ticket: input.ticket,
    graph: "design-graph",
    worktree: false,
    // The cast is honest: `input`'s check already refused anything but the two values at decode.
    records: input.records as RecordsPolicy | undefined
  }),
  pipeline
})
