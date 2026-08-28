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
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { gitReadRaw } from "mag/runtime/git"
import { platform } from "mag/runtime/platform"
import { nulPaths, RULINGS_PATHSPEC } from "mag/runtime/rulings"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"

/** Blocking findings, an empty list a pass — `review-diff`'s own verdict. */
const VERDICT = verdictSchema(Schema.Struct({ blocking: Schema.Array(Schema.String) }))

/** `review-diff`'s `renderFindings`: the first line names the sha the design and plan stood on. */
const renderFindings = (headSha: string, blocking: readonly string[]): string =>
  [
    `Reviewed at ${headSha}`,
    "",
    blocking.length > 0 ? blocking.map((finding) => `- ${finding}`).join("\n") : "No blocking findings."
  ].join("\n")

/** The altitude, stated as what a blocking finding is; the diff is not named because this node never reads one. */
const reviewBlock = (designPath: string, planPath: string, recycleMapPath: string): readonly string[] => [
  "",
  `Review the design at ${designPath} and the plan at ${planPath} against the ticket, before any code exists. Read both whole. Reply with only the blocking findings, each specific enough to act on; an empty list means both pass. A blocking finding is any of:`,
  "- an acceptance criterion no task in the plan proves, named by id;",
  "- an entry under the design's Open Questions, quoted: a design that leaves a question open is not ready to build;",
  "- a task or design section asking for what a rulings file below forbids, quoting the ruling;",
  `- a task that rebuilds what the recycle map at ${recycleMapPath} says exists.`,
  "Change nothing."
]

/** The rulings files git says exist, or none. Paths are repo-root-relative, what git returned and what resolves from the session's cwd. */
const rulingsBlock = (rulings: readonly string[]): readonly string[] =>
  rulings.length === 0 ? [] : [
    "",
    "This repository states rulings of its own, in the files below:",
    ...rulings.map((file) => `- ${file}`)
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
    readonly dispute?: { readonly findingsPath: string; readonly disputePath: string } | undefined
  },
  rulings: readonly string[]
): string =>
  [
    ...ticketReference(input),
    ...reviewBlock(input.designPath, input.planPath, input.recycleMapPath),
    ...rulingsBlock(rulings),
    ...(input.dispute === undefined ? [] : disputeBlock(input.dispute.findingsPath, input.dispute.disputePath))
  ].join("\n")

/**
 * Reviews the design record and the plan against the ticket, at plan altitude: acceptance-criteria
 * coverage, open questions, and collisions with the repository's own rulings. Read-only by
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
    /** The findings a disputed design pass was answering, present alongside `disputePath` — `review-diff`'s pair, same reasoning. */
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

      const declared = yield* gitReadRaw(
        ["git", "ls-files", "-z", "--full-name", "--", ...RULINGS_PATHSPEC],
        cwd,
        (fields) => new PlanReviewGitFailed(fields)
      )
      const rulings = nulPaths(declared)

      const reply = yield* agent.prompt({
        prompt: promptFor({ ...input, dispute }, rulings),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const findingsPath = yield* writeArtifact(fs, runInfo.runRoot, "review-plan", renderFindings(input.headSha, reply.verdict.blocking)).pipe(
        Effect.catch((error) =>
          Effect.fail(new PlanFindingsWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions }))
        )
      )

      if (reply.verdict.blocking.length > 0) {
        return yield* Effect.fail(
          dispute === undefined
            ? new PlanBlocked({ findingsPath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd })
            : new PlanDisputeRejected({ findingsPath, disputePath: dispute.disputePath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd })
        )
      }
      return { findingsPath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
