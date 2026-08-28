import { Effect, FileSystem, Schema } from "effect"
import {
  PlanBlocked,
  PlanDisputeIncomplete,
  PlanDisputeRejected,
  PlanFindingsWriteFailed,
  PlanReviewGitFailed,
  PlanReviewRunRootMissing
} from "mag/graph-nodes/review-plan/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { declaredRulings, rulingsBlock } from "mag/runtime/rulings"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"
import { compileReviewBrief, PLAN_REVIEW_VERDICT, renderFindings, targetedFinding } from "mag/skills/review-brief"

/** The target, then the charter; the diff is not named because this node never reads one. */
const targetBlock = (designPath: string, planPath: string, priorFindingsPath: string | undefined): readonly string[] => [
  "",
  `Review the design at ${designPath} and the plan at ${planPath}, before any code exists. Read both whole.`,
  "",
  ...compileReviewBrief("plan", priorFindingsPath)
]

/** This altitude's own blocking conditions, on top of the charter's. */
const blockingBlock = (recycleMapPath: string): readonly string[] => [
  "At this altitude a blocking finding is also any of:",
  "- an acceptance criterion no task in the plan proves, named by id;",
  "- a ruling in the design stated as a choice still open, or with no basis named, quoted: the design decides, the plan builds what it decided;",
  "- a task or design section asking for what a rulings file below forbids, quoting the ruling;",
  `- a task that rebuilds what the recycle map at ${recycleMapPath} says exists.`,
  "Change nothing."
]

/** `review-diff`'s `disputeBlock`, addressed to the design's author rather than the build's. */
const disputeBlock = (findingsPath: string, disputePath: string): readonly string[] => [
  "",
  "A previous review pass raised blocking findings on this design and plan, recorded at",
  `${findingsPath}. The design pass that followed is recorded at ${disputePath}: it names the`,
  "finding(s) it disputes rather than fixed. This session has no memory of either pass, read both",
  "files alongside the design and the plan named above. Judge every finding from the findings",
  "document against what the design and plan show now: a finding the dispute answers is settled if",
  "the dispute is right, and every other finding stands or falls on the documents as shown. Block on",
  "anything that still stands, as you would any other finding."
]

const promptFor = (
  input: {
    readonly ticket: string
    readonly title: string
    readonly ticketPath: string
    readonly designPath: string
    readonly planPath: string
    readonly recycleMapPath: string
    readonly priorFindingsPath?: string | undefined
    readonly dispute?: { readonly findingsPath: string; readonly disputePath: string } | undefined
  },
  rulings: readonly string[]
): string =>
  [
    ...ticketReference(input),
    ...targetBlock(input.designPath, input.planPath, input.priorFindingsPath),
    ...blockingBlock(input.recycleMapPath),
    ...rulingsBlock(rulings),
    ...(input.dispute === undefined ? [] : disputeBlock(input.dispute.findingsPath, input.dispute.disputePath))
  ].join("\n")

/**
 * Reviews the design record and the plan against the ticket, at plan altitude: acceptance-criteria
 * coverage, undecided or baseless rulings, and collisions with the repository's own rulings. Read-only by
 * contract, `review-diff`'s precedent: it reports findings and changes nothing, so a blocking
 * finding routes to the producer (`brainstorm`), never back here.
 *
 * No `base` and no diff read: the input schema has no way to name a diff, so the reviewer's
 * blindness to code is a property of the schema, not a promise kept in prose. `headSha` is carried
 * onto the findings and the failure, not gated: the artifacts under review are the two files named
 * by path, and the sha says which tree they were written against.
 */
export const reviewPlan = make({
  name: "review-plan",
  description: "Review the design and the plan against the ticket before any build; block on findings that must be settled.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    designPath: Schema.String,
    planPath: Schema.String,
    /** The reuse map the plan's tasks are checked against: a task that rebuilds a listed thing is a finding. */
    recycleMapPath: Schema.String,
    /** The tree the plan was written against (`plan`'s own `headSha`), stamped on the findings and any failure. */
    headSha: Schema.String,
    /** The previous pass's findings on a send-back that changed the design: this pass judges the delta against them rather than hunting afresh. Never alongside `disputePath`, whose own block governs an adjudicating pass. */
    priorFindingsPath: Schema.optional(Schema.String),
    /** The findings a disputed design pass was answering, present alongside `disputePath`, `review-diff`'s pair, same reasoning. */
    findingsPath: Schema.optional(Schema.String),
    /** The design pass's dispute of the previous verdict. Present makes this pass the decider: a blocking verdict is {@link PlanDisputeRejected}, which ends the run. */
    disputePath: Schema.optional(Schema.String),
    /** A named agent to run the session as, same convention as `review-diff`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    findingsPath: Schema.String,
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      if ((input.findingsPath === undefined) !== (input.disputePath === undefined)) {
        return yield* Effect.fail(new PlanDisputeIncomplete({ findingsPath: input.findingsPath, disputePath: input.disputePath }))
      }
      const dispute = input.findingsPath === undefined || input.disputePath === undefined
        ? undefined
        : { findingsPath: input.findingsPath, disputePath: input.disputePath }

      const agent = yield* ClaudeAgent
      const fs = yield* FileSystem.FileSystem
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new PlanReviewRunRootMissing())
      const cwd = workdir(runInfo)

      const rulings = yield* declaredRulings(cwd, (fields) => new PlanReviewGitFailed(fields))

      const reply = yield* agent.prompt({
        prompt: promptFor({ ...input, dispute }, rulings),
        jsonSchema: PLAN_REVIEW_VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const rendered = {
        ...reply.verdict,
        blocking: reply.verdict.blocking.map(({ target, finding }) => targetedFinding(target, finding))
      }
      const findingsPath = yield* writeArtifact(fs, runInfo.runRoot, "review-plan", renderFindings(input.headSha, rendered)).pipe(
        Effect.catch((error) =>
          Effect.fail(new PlanFindingsWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions }))
        )
      )

      if (reply.verdict.blocking.length > 0) {
        // The targets ride the failure so the loop can resume the session that owns the artifact,
        // without re-reading the findings file it just wrote.
        const targets = reply.verdict.blocking.map(({ target }) => target)
        return yield* Effect.fail(
          dispute === undefined
            ? new PlanBlocked({ findingsPath, targets, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd })
            : new PlanDisputeRejected({ findingsPath, disputePath: dispute.disputePath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd })
        )
      }
      return { findingsPath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
