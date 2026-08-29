import { Effect, Option, Result, Schema } from "effect"
import { brainstorm } from "mag/graph-nodes/brainstorm/graph-node"
import { plan } from "mag/graph-nodes/plan/graph-node"
import { recycleScan } from "mag/graph-nodes/recycle-scan/graph-node"
import type { PlanBlocked } from "mag/graph-nodes/review-plan/errors"
import { reviewPlan } from "mag/graph-nodes/review-plan/graph-node"
import { make } from "mag/runtime/graph-node.definition"
import type { FindingTarget } from "mag/skills/review-brief"

/** The loop's whole spend, folded pass by pass, `build-under-review`'s own reduction; `null` poisons the total. */
interface Spend {
  readonly costUsd: number | null
  readonly sessions: readonly string[]
}

const charge = (spend: Spend, sessions: readonly string[], costUsd: number | null): Spend => ({
  costUsd: spend.costUsd === null || costUsd === null ? null : spend.costUsd + costUsd,
  sessions: [...spend.sessions, ...sessions]
})

/**
 * Which producer a blocked verdict resumes: the plan session alone when every finding is the
 * plan's, the design session otherwise. A design-bound pass may still carry plan findings; those
 * reach the plan session afterwards, resumed over the same findings file.
 */
const producerOf = (targets: readonly FindingTarget[]): FindingTarget => targets.every((target) => target === "plan") ? "plan" : "design"

/** The design as the loop last saw it; the dispute pair rides along only on the pass that filed it. */
interface DesignState {
  readonly designPath: string
  readonly sessionRef: string
  readonly findingsPath?: string
  readonly disputePath?: string
}

interface PlanState {
  readonly planPath: string
  readonly headSha: string
  readonly sessionRef: string
  /** The scan the plan was written over; a resumed plan pass cites the same one, since the design it scanned stood. */
  readonly recycleScanPath: string
}

/**
 * The design lane's backward edge as a composite GraphNode, `build-under-review`'s shape:
 * brainstorm → recycle-scan → plan → review-plan, a blocking review sending its findings back to the session
 * that owns the artifact each finding names, at most `cap` times per producer. The loop is one
 * generator over the error channel, `PLAN_BLOCKED` IS the failure track, and its state lives in
 * loop locals, so nothing about the loop escapes this node.
 *
 * A finding names its target (`review-plan`'s verdict). Every finding on the plan resumes the plan
 * session over the findings and leaves the design and its session untouched. Any finding on the
 * design resumes the brainstorm session; the plan then runs fresh over a fresh scan when the design changed, is
 * resumed over the same findings when the design stood but a plan finding remains, and stands as
 * it was when the design disputed and nothing was the plan's. Two caps, one number: design
 * send-backs and plan send-backs each count against `cap` on their own, so one fix of each fits
 * under `cap: 1`, and `reviewPasses` stays the total.
 *
 * The reviewer is blind to code by the schema of `review-plan` itself (no `base`, no diff), and
 * fresh every pass; the one exception is an adjudicating pass, handed the design's own dispute of
 * the findings it is re-reviewing. That pass decides the disputed findings only: one rejected is
 * `PlanDisputeRejected`, which escalates, there is no design work a third pass could invent over a
 * defect the design already denied. Every other blocking finding of that pass, new or carried,
 * routes to its target under the cap as on any pass; an upheld dispute is remembered so the
 * settling success still names it. No build node is reachable from here.
 */
export const designUnderReview = make({
  name: "design-under-review",
  description: "Design, scan the repo for the design's names, plan, and review before any build; findings sent back to the session they name until clean or the cap is spent.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    /** The already-composed, already-budget-checked brainstorm prompt (`assemble-brainstorm-prompt`'s success). */
    prompt: Schema.String,
    visionPaths: Schema.Array(Schema.String),
    discoverPath: Schema.String,
    /** Max send-backs per producer: brainstorm and plan are each resumed at most `cap` times. */
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
    /** Present when a review pass upheld a dispute on the way to settling, on that pass or a later one. */
    disputePath: Schema.optional(Schema.String),
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agentField = input.agent === undefined ? {} : { agent: input.agent }
      const modelField = input.model === undefined ? {} : { model: input.model }
      const ticketFields = { ticket: input.ticket, title: input.title, ticketPath: input.ticketPath }
      // The discover note feeds the design only; the plan cites the design and its recycle scan.
      const citations = { discoverPath: input.discoverPath }

      let prior = Option.none<PlanBlocked>()
      let spent: Spend = { costUsd: 0, sessions: [] }
      const sendbacks = { design: 0, plan: 0 }
      let designed: DesignState | undefined = undefined
      let planned: PlanState | undefined = undefined
      let upheldDispute: string | undefined = undefined

      for (let passes = 1; ; passes += 1) {
        const producer = Option.map(prior, (blocked) => producerOf(blocked.targets))
        const findings = Option.map(prior, (blocked) => blocked.findingsPath)

        // The design pass: first, or resumed over any design finding. A plan-only verdict skips it.
        let designChanged = false
        const priorDesign: DesignState | undefined = designed
        let currentDesign: DesignState
        if (priorDesign === undefined || Option.contains(producer, "design")) {
          const pass = yield* brainstorm.run({
            ...ticketFields,
            prompt: input.prompt,
            visionPaths: input.visionPaths,
            ...citations,
            ...agentField,
            ...modelField,
            ...(priorDesign === undefined || Option.isNone(findings) ? {} : { findingsPath: findings.value, resume: priorDesign.sessionRef })
          })
          spent = charge(spent, pass.sessions, pass.costUsd)
          designChanged = pass.changed
          currentDesign = { designPath: pass.designPath, sessionRef: pass.sessionRef, ...(pass.disputePath === undefined ? {} : { findingsPath: pass.findingsPath, disputePath: pass.disputePath }) }
        } else {
          currentDesign = { designPath: priorDesign.designPath, sessionRef: priorDesign.sessionRef }
        }
        designed = currentDesign

        // The plan pass: fresh over a new or changed design, scanned first, resumed over the findings
        // when a plan finding stands on an unchanged design, untouched when the design disputed alone.
        const planFinding = Option.exists(prior, (blocked) => blocked.targets.includes("plan"))
        const priorPlan: PlanState | undefined = planned
        let currentPlan: PlanState
        if (priorPlan === undefined || designChanged) {
          const scanned = yield* recycleScan.run({ designPath: currentDesign.designPath })
          const fresh = yield* plan.run({ ...ticketFields, designPath: currentDesign.designPath, recycleScanPath: scanned.recycleScanPath, ...agentField, ...modelField })
          spent = charge(spent, fresh.sessions, fresh.costUsd)
          currentPlan = { planPath: fresh.planPath, headSha: fresh.headSha, sessionRef: fresh.sessionRef, recycleScanPath: scanned.recycleScanPath }
        } else if (planFinding && Option.isSome(findings)) {
          const resumed = yield* plan.run({
            ...ticketFields,
            designPath: currentDesign.designPath,
            recycleScanPath: priorPlan.recycleScanPath,
            ...agentField,
            ...modelField,
            findingsPath: findings.value,
            resume: priorPlan.sessionRef
          })
          spent = charge(spent, resumed.sessions, resumed.costUsd)
          currentPlan = { planPath: resumed.planPath, headSha: resumed.headSha, sessionRef: resumed.sessionRef, recycleScanPath: priorPlan.recycleScanPath }
        } else {
          currentPlan = priorPlan
        }
        planned = currentPlan

        // A dispute filed this pass makes the review adjudicating; otherwise a send-back hands the
        // reviewer the prior findings, so pass 2 judges the delta instead of re-hunting.
        const adjudication = currentDesign.findingsPath === undefined || currentDesign.disputePath === undefined
          ? Option.match(findings, { onNone: () => ({}), onSome: (findingsPath) => ({ priorFindingsPath: findingsPath }) })
          : { findingsPath: currentDesign.findingsPath, disputePath: currentDesign.disputePath }

        const reviewed = yield* Effect.result(
          reviewPlan.run({
            ...ticketFields,
            designPath: currentDesign.designPath,
            planPath: currentPlan.planPath,
            headSha: currentPlan.headSha,
            ...adjudication,
            ...agentField,
            ...modelField
          })
        )

        // Any outcome but a rejection means the adjudicating pass upheld the dispute it was handed.
        if (currentDesign.disputePath !== undefined && !(Result.isFailure(reviewed) && reviewed.failure._tag === "PLAN_DISPUTE_REJECTED")) {
          upheldDispute = currentDesign.disputePath
        }

        if (Result.isSuccess(reviewed)) {
          spent = charge(spent, reviewed.success.sessions, reviewed.success.costUsd)
          return {
            designPath: currentDesign.designPath,
            planPath: currentPlan.planPath,
            headSha: currentPlan.headSha,
            reviewPasses: passes,
            ...(upheldDispute === undefined ? {} : { disputePath: upheldDispute }),
            sessions: spent.sessions,
            costUsd: spent.costUsd
          }
        }

        const failure = reviewed.failure
        if (failure._tag !== "PLAN_BLOCKED") return yield* Effect.fail(failure)
        const next = producerOf(failure.targets)
        if (sendbacks[next] >= input.cap) return yield* Effect.fail(failure)
        sendbacks[next] += 1
        spent = charge(spent, failure.sessions, failure.costUsd)
        prior = Option.some(failure)
      }
    })
})
