import { Effect, Option, Result, Schema } from "effect"
import { designAddendum, verificationAddendum } from "mag/graph-nodes/build-under-review/addenda"
import { BuildTddInputsMissing } from "mag/graph-nodes/build-under-review/errors"
import { build } from "mag/graph-nodes/build/graph-node"
import type { ReviewBlocked, ReviewDisputeRejected } from "mag/graph-nodes/review-diff/errors"
import { reviewDiff } from "mag/graph-nodes/review-diff/graph-node"
import { simplify } from "mag/graph-nodes/simplify/graph-node"
import { tddBuild } from "mag/graph-nodes/tdd-build/graph-node"
import { verification } from "mag/graph-nodes/verification/graph-node"
import { recognizeAcceptanceCriteria } from "mag/runtime/acceptance-criteria"
import { make } from "mag/runtime/graph-node.definition"
import { charge, NO_SPEND, type Spend } from "mag/runtime/spend"

/** `REVIEW_BLOCKED` always routes back to `build`; `REVIEW_DISPUTE_REJECTED` joins it only on the committed edge, where the tree moved. */
const sendsBack = (failure: { readonly _tag: string }): failure is ReviewBlocked | ReviewDisputeRejected =>
  failure._tag === "REVIEW_BLOCKED" || failure._tag === "REVIEW_DISPUTE_REJECTED"

/**
 * The TDD lane's policy: pipeline judgment, not a per-repository fact, so constants here rather
 * than more input fields (`graphs/develop-graph/graph.ts`'s `REVIEW_CAP` reasoning). One escape
 * round after the first, `red-green`'s own send-backs, three blind breakers of three claims each,
 * and the model per step the lane was measured with.
 */
const TDD_ESCAPE_CAP = 1
const TDD_RED_GREEN_CAP = 2
const TDD_BREAKERS = 3
const TDD_BUDGET = 3
const TDD_MODELS = { planModel: "opus", writeModel: "sonnet", implementModel: "sonnet", breakModel: "sonnet", judgeModel: "haiku" }

/** What the loop reads off a first pass, whichever node built it: `build`'s own success is one, `tdd-build`'s is mapped onto it. */
interface BuiltPass {
  readonly summaryPath: string
  readonly commits: number
  readonly headSha: string
  readonly sessions: readonly string[]
  readonly costUsd: number | null
  readonly sessionRef: string
  readonly findingsPath?: string | undefined
  readonly disputePath?: string | undefined
}

/** Either first pass's own failure union, the loop's `BUILD_DISPUTED` check narrowing over both. */
type FirstPassError = Effect.Error<ReturnType<typeof build.run>> | Effect.Error<ReturnType<typeof tddBuild.run>>

/**
 * The backward edge as a composite GraphNode: build →
 * verification → simplify → review-diff, a blocking review sending its findings back into build, at
 * most `cap` times. The loop is one generator over the error channel — `REVIEW_BLOCKED` IS the
 * failure track — and its state (the prior block, the send-back count, the folded spend) lives in
 * loop locals of a single fiber's single generator, so nothing about the loop escapes this node.
 *
 * `simplify` runs once per pass, between `verification` and `reviewDiff`, on the ordinary
 * success edge only — never on the `BUILD_DISPUTED` edge below, which has no green build to reduce.
 * The reviewer is handed `simplify`'s own `headSha`, not `build`'s: a
 * subtraction commit that never reached the diff the review judges would defeat the gate this
 * mechanism exists to add. A second `verification.run` follows only when `simplify` actually moved
 * `HEAD` — an unmoved tree already passed the suite on that exact sha, so re-running it proves
 * nothing.
 *
 * The review only ever sees a diff that passed verification: verification runs
 * inside every pass, and its failure ends the loop before the reviewer is ever dispatched, except
 * that a red suite is no longer automatically fatal: {@link verified} repairs it in
 * place first, by resuming the session that produced the red head, before the loop gives up on it.
 *
 * The reviewer is blind by construction: it is dispatched with the ticket, the diff
 * and the head sha it is gating — never the build session, never a build summary, never the design
 * rationale in prose, and never its own prior session. A resumed session let review pass 2
 * answer from its memory of pass 1's diff instead of the tree in front of it; every pass is now a
 * fresh session over the current diff, so there is no memory to answer from. One named exception:
 * an adjudicating pass is handed the builder's own dispute of the findings it is re-reviewing.
 *
 * A send-back pass that ends with a clean tree, no commit, and a dispute in its reply is not
 * escalated like every other build failure — `BUILD_DISPUTED` is caught here, on its own edge, and
 * routed to one more `review-diff` pass carrying the dispute alongside the unchanged diff. That
 * pass's own verdict is terminal either way on *this* edge: a clean review settles the loop, and a
 * second block — `ReviewDisputeRejected`, not `REVIEW_BLOCKED` — is not routed back to build (there
 * is no work a third build pass could invent that would not fabricate a fix, because the tree is
 * byte-identical to the one the findings were raised against), so it escalates like any other
 * unhandled failure. `verification` is not on this edge: `build` failed, so the generator never
 * reaches it, and the tree an adjudicating pass reviews is the one this run's previous pass already
 * ran the suite over.
 *
 * A send-back pass resumes the build session that produced the reviewed head,
 * `lastBuildSessionRef`, set from `built.success.sessionRef` every pass, rather than opening a
 * fresh one over the findings file alone, so a fix keeps the context that made it a fix. `simplify`'s
 * own session is never the resume target even when its head is what review gated on: `simplify` is
 * ticket-blind by design (`simplify`'s own `promptFor`), so it cannot answer ticket-shaped findings.
 *
 * Under `tdd` the first pass is `tdd-build` rather than `build`: the criteria are read off the
 * ticket body, the plan is written red-first, and the review lane runs before this loop's own
 * reviewer ever sees the diff. That pass's head is already verified inside `tdd-build`, so
 * {@link verified} is not run over it again; every send-back and repair after it is a `build`
 * dispatch resuming the implementing session `tdd-build` returned, exactly as after a `build`
 * first pass. Off by default, so the loop as it was is the loop as it is.
 *
 * This node mints one error of its own, {@link BuildTddInputsMissing}, for a `tdd` pass asked for
 * without the inputs it needs; every other tag is the union its parts already produce, and a
 * cap-spent loop refails the reviewer's own blocking tag, findings still aboard.
 */
export const buildUnderReview = make({
  name: "build-under-review",
  description: "Build and verify under a diff review, findings sent back until clean or the cap is spent.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    body: Schema.String,
    branch: Schema.String,
    command: Schema.String,
    base: Schema.String,
    /** Max send-backs: build runs at most `cap + 1` times. Negative has no meaning here. */
    cap: Schema.Natural,
    /**
     * A repo-relative design file for the first build pass to work from; the graph that
     * ran a design step passes it, a graph without one omits it. Send-back passes replace it with
     * the reviewer's findings — the review verdict outranks the plan it reviewed against.
     */
    designPath: Schema.optional(Schema.String),
    /** A named agent for every session this node dispatches — same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /**
     * `--model` for the build dispatch, same convention as `agent`. The composite owns two
     * dispatches with two different assignments, so it carries two model fields rather than one.
     */
    buildModel: Schema.optional(Schema.String),
    /** `--model` for the simplify dispatch — the composite's third `--model` assignment, same convention. */
    simplifyModel: Schema.optional(Schema.String),
    /** `--model` for the review-diff dispatch — the composite's other half of the same convention. */
    reviewModel: Schema.optional(Schema.String),
    /** Build the first pass through `tdd-build` instead of `build`. Absent is off: the loop unchanged. */
    tdd: Schema.optional(Schema.Boolean),
    /** The recon note `tdd-build`'s planner reads. `run` requires it whenever `tdd` is on. */
    discoverPath: Schema.optional(Schema.String),
    /** `assert-red`'s per-path test command, `$1` the test path. `run` requires it whenever `tdd` is on. */
    testCommand: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    summaryPath: Schema.String,
    commits: Schema.Int,
    reviewPasses: Schema.Int,
    /** The head the settling review pass gated — where the loop left the tree, for anything composed after it. */
    headSha: Schema.String,
    /** Present when the loop settled on a dispute a review pass accepted. */
    disputePath: Schema.optional(Schema.String),
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agentField = input.agent === undefined ? {} : { agent: input.agent }
      const buildModelField = input.buildModel === undefined ? {} : { model: input.buildModel }
      const simplifyModelField = input.simplifyModel === undefined ? {} : { model: input.simplifyModel }
      const reviewModelField = input.reviewModel === undefined ? {} : { model: input.reviewModel }
      const firstAddendum =
        input.designPath === undefined ? {} : { addendum: designAddendum(input.designPath) }
      // Checked before any read: a `tdd` pass with nothing to plan against or no way to assert red
      // is a wiring bug, refused before a session is spent (`BuildResumeEmpty`'s position).
      const tddInputs = input.tdd === true
        ? input.discoverPath === undefined || input.testCommand === undefined
          ? yield* Effect.fail(new BuildTddInputsMissing({ discoverPath: input.discoverPath, testCommand: input.testCommand }))
          : { discoverPath: input.discoverPath, testCommand: input.testCommand }
        : undefined

      let prior = Option.none<ReviewBlocked | ReviewDisputeRejected>()
      let spent: Spend = NO_SPEND
      // One counter for the whole run, not one per head: a per-head budget multiplies
      // worst-case spend by the review passes, and the loop's cap is meant to be singular.
      let repairs = 0
      // The session a send-back pass resumes, set from the pass whose head review is
      // currently gating. Undefined only before the first pass has ever produced one.
      let lastBuildSessionRef: string | undefined = undefined

      /**
       * Verifies one head and, while it's red, repairs it by resuming the session that produced it:
       * `repairs` and `spent` are this run's own locals, shared across both call sites below, so the
       * cap is spent once per run rather than once per head. Escalates unrepaired when the failure
       * isn't `VERIFICATION_FAILED` (a report-write failure has no report to point a repair at), the
       * cap is spent, or there is no session left to resume. Not wrapped in `Effect.result`: a repair
       * that commits nothing is `BuildNoCommits`, the correct ending for a session that answered a
       * red suite with silence. Returns the commits the repair(s) added, since the caller's own
       * `commits` total is per-pass and this helper's state is not.
       */
      const verified = (head: string, producer: string | undefined) =>
        Effect.gen(function* () {
          let currentHead = head
          let currentProducer = producer
          let addedCommits = 0
          while (true) {
            const checked = yield* Effect.result(
              verification.run({ command: input.command, headSha: currentHead })
            )
            if (Result.isSuccess(checked)) return { headSha: currentHead, commits: addedCommits }

            const failure = checked.failure
            if (failure._tag !== "VERIFICATION_FAILED" || repairs === input.cap || currentProducer === undefined) {
              return yield* Effect.fail(failure)
            }

            repairs += 1
            // This call carries no `findingsPath`, so `build`'s `recordDispute` can never record one
            // here, whatever the session replies. `BUILD_DISPUTED` is still part of `build.run`'s
            // type, though, and `errors.ts` excludes it from this composite's own union on the
            // strength of that unreachability, so `catchTag` is what keeps that exclusion true
            // rather than merely asserted, dying the way `journaled`'s `appendRow` dies on a failure
            // this caller could never have handled.
            const repaired = yield* build.run({
              ticket: input.ticket,
              title: input.title,
              body: input.body,
              branch: input.branch,
              resume: currentProducer,
              addendum: verificationAddendum(failure.reportPath),
              ...agentField,
              ...buildModelField
            }).pipe(Effect.catchTag("BUILD_DISPUTED", (disputed) => Effect.die(disputed)))
            spent = charge(spent, repaired.sessions, repaired.costUsd)
            addedCommits += repaired.commits
            currentHead = repaired.headSha
            currentProducer = repaired.sessionRef
          }
        })

      for (let sendbacks = 0; ; sendbacks += 1) {
        // Only the first pass goes through `tdd-build`; a send-back answers findings against a tree
        // that already has its tests, which is `build`'s own resumed-session shape.
        const viaTdd = Option.isNone(prior) && tddInputs !== undefined
        // Annotated: the two arms' error unions differ, and a bare ternary leaves them as two
        // Effect types rather than one over the joined union.
        const pass: Effect.Effect<BuiltPass, FirstPassError> = viaTdd && tddInputs !== undefined
            ? tddBuild.run({
              acs: recognizeAcceptanceCriteria(input.body).criteria,
              discoverPath: tddInputs.discoverPath,
              base: input.base,
              command: input.command,
              testCommand: tddInputs.testCommand,
              cap: TDD_ESCAPE_CAP,
              redGreenCap: TDD_RED_GREEN_CAP,
              breakers: TDD_BREAKERS,
              budget: TDD_BUDGET,
              ...agentField,
              ...TDD_MODELS
            }).pipe(
              // Mapped onto the shape the loop reads off `build`; a tdd pass carries no dispute pair.
              Effect.map((made): BuiltPass => ({
                summaryPath: made.summaryPath,
                commits: made.commits,
                headSha: made.headSha,
                sessions: made.sessions,
                costUsd: made.costUsd,
                sessionRef: made.sessionRef
              }))
            )
            : build.run({
              ticket: input.ticket,
              title: input.title,
              body: input.body,
              branch: input.branch,
              ...agentField,
              ...buildModelField,
              ...Option.match(prior, {
                onNone: () => firstAddendum,
                onSome: (blocked) => ({ findingsPath: blocked.findingsPath, resume: lastBuildSessionRef })
              })
            }).pipe(Effect.map((made): BuiltPass => made))
        const built = yield* Effect.result(pass)

        if (Result.isFailure(built)) {
          const failure = built.failure
          if (failure._tag !== "BUILD_DISPUTED") return yield* Effect.fail(failure)

          // The dispute edge. Charge the pass's own spend, then dispatch one adjudicating
          // review pass carrying the dispute and the disputed head — not wrapped in `Effect.result`,
          // since every failure it can produce, `ReviewDisputeRejected` included, is one this loop
          // should end on rather than route further. `verification` is skipped by construction: the
          // build pass that would feed it failed, so the generator never reaches that call.
          spent = charge(spent, failure.sessions, failure.costUsd)
          const adjudicated = yield* reviewDiff.run({
            ticket: input.ticket,
            title: input.title,
            body: input.body,
            base: input.base,
            headSha: failure.headSha,
            findingsPath: failure.findingsPath,
            disputePath: failure.disputePath,
            ...agentField,
            ...reviewModelField
          })
          spent = charge(spent, adjudicated.sessions, adjudicated.costUsd)
          return {
            summaryPath: failure.summaryPath,
            commits: failure.commits,
            reviewPasses: sendbacks + 1,
            headSha: failure.headSha,
            disputePath: failure.disputePath,
            sessions: spent.sessions,
            costUsd: spent.costUsd
          }
        }

        spent = charge(spent, built.success.sessions, built.success.costUsd)
        lastBuildSessionRef = built.success.sessionRef

        // Repair a red build head in place rather than let it end the run. A `tdd-build` head was
        // verified inside that node, on this exact sha, so it is not re-run here.
        const builtVerified = viaTdd
          ? { headSha: built.success.headSha, commits: 0 }
          : yield* verified(built.success.headSha, built.success.sessionRef)

        // The subtraction pass, once per build pass, before the review that judges the
        // diff — so its own commit is always in what review sees. `reduced.headSha` is what
        // `reviewDiff` gates on below, not `built.success.headSha`: that substitution is the whole
        // mechanism.
        const reduced = yield* simplify.run({
          ticket: input.ticket,
          base: input.base,
          headSha: builtVerified.headSha,
          ...agentField,
          ...simplifyModelField
        })
        spent = charge(spent, reduced.sessions, reduced.costUsd)
        // Only a tree `simplify` actually moved needs re-verifying — an unmoved sha already
        // passed the suite above. Repair that head too, resuming `simplify`'s own session,
        // before handing the result to review.
        const reviewVerified = reduced.simplified
          ? yield* verified(reduced.headSha, reduced.sessionRef)
          : { headSha: reduced.headSha, commits: 0 }

        // Present only when this pass produced a dispute.
        const adjudication = built.success.findingsPath === undefined || built.success.disputePath === undefined
          ? {}
          : { findingsPath: built.success.findingsPath, disputePath: built.success.disputePath }

        const reviewed = yield* Effect.result(
          reviewDiff.run({
            ticket: input.ticket,
            title: input.title,
            body: input.body,
            base: input.base,
            headSha: reviewVerified.headSha,
            ...adjudication,
            ...agentField,
            ...reviewModelField
          })
        )

        if (Result.isSuccess(reviewed)) {
          spent = charge(spent, reviewed.success.sessions, reviewed.success.costUsd)
          return {
            summaryPath: built.success.summaryPath,
            commits: built.success.commits + builtVerified.commits + reviewVerified.commits,
            reviewPasses: sendbacks + 1,
            headSha: reviewVerified.headSha,
            // An accepted dispute rides the composite's own success too.
            ...(built.success.disputePath === undefined ? {} : { disputePath: built.success.disputePath }),
            sessions: spent.sessions,
            costUsd: spent.costUsd
          }
        }

        const failure = reviewed.failure
        if (!sendsBack(failure) || sendbacks >= input.cap) {
          return yield* Effect.fail(failure)
        }
        spent = charge(spent, failure.sessions, failure.costUsd)
        prior = Option.some(failure)
      }
    })
})
