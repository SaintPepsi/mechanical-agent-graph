import { Effect, Option, Result, Schema } from "effect"
import { brainstorm } from "mag/graph-nodes/brainstorm/graph-node"
import { plan } from "mag/graph-nodes/plan/graph-node"
import type { PlanBlocked } from "mag/graph-nodes/review-plan/errors"
import { reviewPlan } from "mag/graph-nodes/review-plan/graph-node"
import { make } from "mag/runtime/graph-node.definition"

/** The loop's whole spend, folded pass by pass — `build-under-review`'s own reduction; `null` poisons the total. */
interface Spend {
  readonly costUsd: number | null
  readonly sessions: readonly string[]
}

const charge = (spend: Spend, sessions: readonly string[], costUsd: number | null): Spend => ({
  costUsd: spend.costUsd === null || costUsd === null ? null : spend.costUsd + costUsd,
  sessions: [...spend.sessions, ...sessions]
})

/**
 * The design lane's backward edge as a composite GraphNode, `build-under-review`'s shape:
 * brainstorm → plan → review-plan, a blocking review sending its findings back into brainstorm, at
 * most `cap` times. The loop is one generator over the error channel — `PLAN_BLOCKED` IS the
 * failure track — and its state lives in loop locals, so nothing about the loop escapes this node.
 *
 * A send-back resumes the brainstorm session that wrote the reviewed design (`sessionRef`), so a
 * fix keeps the context that made the design; a fresh session would re-derive it. `plan` runs
 * again only when the design changed: a dispute-only pass leaves the design and therefore the
 * plan as they were, so the previous plan stands and the adjudicating review reads it.
 *
 * The reviewer is blind to code by the schema of `review-plan` itself (no `base`, no diff), and
 * fresh every pass; the one exception is an adjudicating pass, handed the design's own dispute of
 * the findings it is re-reviewing. That pass's verdict is terminal either way: clean settles the
 * loop, blocked is `PlanDisputeRejected`, which escalates — there is no design work a third pass
 * could invent over documents that did not change. No build node is reachable from here.
 */
export const designUnderReview = make({
  name: "design-under-review",
  description: "Design, plan, and review both before any build; findings sent back into the design until clean or the cap is spent.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    body: Schema.String,
    /** The already-composed, already-budget-checked brainstorm prompt (`assemble-brainstorm-prompt`'s success). */
    prompt: Schema.String,
    visionPaths: Schema.Array(Schema.String),
    discoverPath: Schema.String,
    /** Max send-backs: brainstorm runs at most `cap + 1` times. */
    cap: Schema.Natural,
    /** A named agent for every session this node dispatches. */
    agent: Schema.optional(Schema.String),
    /** `--model` for every session this node dispatches: the three are one judgment tier. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    designPath: Schema.String,
    planPath: Schema.String,
    /** The tree the settling plan was written against. */
    headSha: Schema.String,
    reviewPasses: Schema.Int,
    /** Present when the loop settled on a dispute a review pass accepted. */
    disputePath: Schema.optional(Schema.String),
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agentField = input.agent === undefined ? {} : { agent: input.agent }
      const modelField = input.model === undefined ? {} : { model: input.model }
      const ticketFields = { ticket: input.ticket, title: input.title, body: input.body }

      let prior = Option.none<PlanBlocked>()
      let spent: Spend = { costUsd: 0, sessions: [] }
      let lastSessionRef: string | undefined = undefined
      let planned: { readonly planPath: string; readonly headSha: string } | undefined = undefined

      for (let sendbacks = 0; ; sendbacks += 1) {
        const designed = yield* brainstorm.run({
          ...ticketFields,
          prompt: input.prompt,
          visionPaths: input.visionPaths,
          discoverPath: input.discoverPath,
          ...agentField,
          ...modelField,
          ...Option.match(prior, {
            onNone: () => ({}),
            onSome: (blocked) => ({ findingsPath: blocked.findingsPath, resume: lastSessionRef })
          })
        })
        spent = charge(spent, designed.sessions, designed.costUsd)
        lastSessionRef = designed.sessionRef

        if (designed.changed || planned === undefined) {
          const fresh = yield* plan.run({
            ...ticketFields,
            designPath: designed.designPath,
            discoverPath: input.discoverPath,
            ...agentField,
            ...modelField
          })
          spent = charge(spent, fresh.sessions, fresh.costUsd)
          planned = { planPath: fresh.planPath, headSha: fresh.headSha }
        }

        const adjudication = designed.findingsPath === undefined || designed.disputePath === undefined
          ? {}
          : { findingsPath: designed.findingsPath, disputePath: designed.disputePath }

        const reviewed = yield* Effect.result(
          reviewPlan.run({
            ...ticketFields,
            designPath: designed.designPath,
            planPath: planned.planPath,
            headSha: planned.headSha,
            ...adjudication,
            ...agentField,
            ...modelField
          })
        )

        if (Result.isSuccess(reviewed)) {
          spent = charge(spent, reviewed.success.sessions, reviewed.success.costUsd)
          return {
            designPath: designed.designPath,
            planPath: planned.planPath,
            headSha: planned.headSha,
            reviewPasses: sendbacks + 1,
            ...(designed.disputePath === undefined ? {} : { disputePath: designed.disputePath }),
            sessions: spent.sessions,
            costUsd: spent.costUsd
          }
        }

        const failure = reviewed.failure
        if (failure._tag !== "PLAN_BLOCKED" || sendbacks >= input.cap) {
          return yield* Effect.fail(failure)
        }
        spent = charge(spent, failure.sessions, failure.costUsd)
        prior = Option.some(failure)
      }
    })
})
