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

/** The target, then the charter; the diff is not named because this node never reads one, and neither is the design: the plan is what this node reads, and what it judges from. */
const targetBlock = (planPath: string, priorFindingsPath: string | undefined): readonly string[] => [
  "",
  `Review the plan at ${planPath}, before any code exists.`,
  "",
  ...compileReviewBrief("plan", priorFindingsPath)
]

/** This altitude's own blocking conditions, on top of the charter's. */
const blockingBlock: readonly string[] = [
  "At this altitude a blocking finding is also any of:",
  "- an acceptance criterion no task in the plan proves, named by id;",
  "- a ruling in the design stated as a choice still open, or with no basis named, quoted: the design decides, the plan builds what it decided;",
  "- a task or design section asking for what a rulings file below forbids, quoting the ruling;",
  "Change nothing."
]

/** `review-diff`'s `disputeBlock`, addressed to the design's author rather than the build's. */
const disputeBlock = (findingsPath: string, disputePath: string): readonly string[] => [
  "",
  "A previous review pass raised blocking findings on this design and plan, recorded at",
  `${findingsPath}. The design pass that followed is recorded at ${disputePath}: it names the`,
  "finding(s) it disputes rather than fixed. This session has no memory of either pass, read both",
  "files alongside the plan named above. Decide each disputed finding in `disputed`,",
  "quoted: upheld true when the dispute is right and the defect is not there, false when the defect",
  "stands. A disputed finding goes there and nowhere else. Every other finding from the findings",
  "document, and anything new, stands or falls on the documents as shown: blocking or a note, as on",
  "any pass."
]

const promptFor = (
  input: {
    readonly ticket: string
    readonly title: string
    readonly ticketPath: string
    readonly planPath: string
    readonly priorFindingsPath?: string | undefined
    readonly dispute?: { readonly findingsPath: string; readonly disputePath: string } | undefined
  },
  rulings: readonly string[]
): string =>
  [
    ...ticketReference(input),
    ...targetBlock(input.planPath, input.priorFindingsPath),
    ...blockingBlock,
    ...rulingsBlock(rulings),
    ...(input.dispute === undefined ? [] : disputeBlock(input.dispute.findingsPath, input.dispute.disputePath))
  ].join("\n")

/**
 * Reviews the plan against the ticket, at plan altitude: acceptance-criteria coverage, undecided or
 * baseless rulings (quoted from the plan's own citation of them), and collisions with the
 * repository's own rulings. Read-only by contract, `review-diff`'s precedent: it reports findings
 * and changes nothing, so a blocking finding routes to the producer (`brainstorm`), never back here.
 *
 * No `base`, no diff and no `designPath`: the input schema has no way to name any of them, so the
 * reviewer's blindness to code and to the design record is a property of the schema, not a promise
 * kept in prose. The design is the plan's input and nothing else's — the plan is what this node
 * judges from, and it carries whatever design decisions and principles it applies, in its own
 * words; a decision the plan never states is a plan finding on that ground alone. `headSha` is
 * carried onto the findings and the failure, not gated: the artifact under review is the one file
 * named by path, and the sha says which tree it was written against.
 */
export const reviewPlan = make({
  name: "review-plan",
  description: "Review the plan against the ticket before any build; block on findings that must be settled.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    planPath: Schema.String,
    /** The tree the plan was written against (`plan`'s own `headSha`), stamped on the findings and any failure. */
    headSha: Schema.String,
    /** The previous pass's findings on a send-back that changed the design: this pass judges the delta against them rather than hunting afresh. Never alongside `disputePath`, whose own block governs an adjudicating pass. */
    priorFindingsPath: Schema.optional(Schema.String),
    /** The findings a disputed design pass was answering, present alongside `disputePath`, `review-diff`'s pair, same reasoning. */
    findingsPath: Schema.optional(Schema.String),
    /** The design pass's dispute of the previous verdict. Present makes this pass the decider of the disputed findings only: one rejected is {@link PlanDisputeRejected}, which ends the run; every other blocking finding is {@link PlanBlocked} as on any pass. */
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

      // Rulings count only on an adjudicating pass: an ordinary pass was handed no dispute to rule on.
      const disputed = dispute === undefined ? [] : reply.verdict.disputed ?? []
      const rendered = {
        blocking: reply.verdict.blocking.map(({ target, finding }) => targetedFinding(target, finding)),
        notes: reply.verdict.notes,
        disputed
      }
      const findingsPath = yield* writeArtifact(fs, runInfo.runRoot, "review-plan", renderFindings(input.headSha, rendered)).pipe(
        Effect.catch((error) =>
          Effect.fail(new PlanFindingsWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions }))
        )
      )

      // A rejected disputed finding ends the run; an upheld dispute leaves this pass an ordinary
      // one, whose blocking findings route to their targets as on any pass.
      if (dispute !== undefined && disputed.some((ruling) => !ruling.upheld)) {
        return yield* Effect.fail(
          new PlanDisputeRejected({ findingsPath, disputePath: dispute.disputePath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd })
        )
      }
      if (reply.verdict.blocking.length > 0) {
        // The targets ride the failure so the loop can resume the session that owns the artifact,
        // without re-reading the findings file it just wrote.
        const targets = reply.verdict.blocking.map(({ target }) => target)
        return yield* Effect.fail(new PlanBlocked({ findingsPath, targets, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd }))
      }
      return { findingsPath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
