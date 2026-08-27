import { Effect, FileSystem, Schema } from "effect"
import {
  AnalysisIncomplete,
  AnalysisRunRootMissing,
  ReportWriteFailed,
  WindowUnreadable
} from "mag/graph-nodes/analyse-reviews/errors"
import { missingAttributions, renderReport } from "mag/graph-nodes/analyse-reviews/report"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { ATTRIBUTIONS, type ReviewWindow, ReviewWindowSchema } from "mag/runtime/review-window"
import { RunInfo } from "mag/runtime/run-info"

/**
 * What the session must return: an attribution per send-back, any
 * recurring pattern across two or more, and a free-text note for anything the closed shape didn't
 * have a field for.
 */
const ANALYSIS = verdictSchema(Schema.Struct({
  sendBacks: Schema.Array(Schema.Struct({
    id: Schema.String,
    attribution: Schema.Literals(ATTRIBUTIONS),
    evidence: Schema.String,
    fix: Schema.String
  })),
  patterns: Schema.Array(Schema.Struct({
    pattern: Schema.String,
    attribution: Schema.Literals(ATTRIBUTIONS),
    occurrences: Schema.Array(Schema.String),
    fix: Schema.String
  })),
  note: Schema.String
}))

/**
 * Names the manifest and instructs the session to read it and the artifacts it points at, rather
 * than inlining any of it — an oversized prompt dies at `execve`, and the window can hold five
 * runs' worth of findings, build summaries and designs.
 */
const promptFor = (window: ReviewWindow, manifestPath: string): string =>
  [
    `A window of ${window.passes.length} review passes is recorded at ${manifestPath}. Read that`,
    "file, then read the artifacts each pass names (findings, build summary, design, dispute) to",
    "attribute every send-back in the window.",
    "",
    "For each pass whose verdict is \"blocked\" or \"dispute-rejected\", decide which of these",
    "attributions caused it, and cite the evidence:",
    `- ${ATTRIBUTIONS[0]}: the finding was drive-by, not grounded in the diff or the ticket.`,
    `- ${ATTRIBUTIONS[1]}: the build pass already violated something the design or a governing principles document states.`,
    `- ${ATTRIBUTIONS[2]}: the design never answered the question the finding raises.`,
    `- ${ATTRIBUTIONS[3]}: the reviewer caught a real defect; the send-back did its job.`,
    "",
    `Session transcripts live under ${window.transcriptsRoot}, named by session id. Open one only`,
    "when the artifacts alone do not settle an attribution: it is the most expensive evidence in",
    "the window and the cheapest to open by reflex.",
    "",
    "Attribute every blocked or dispute-rejected pass by id, with its evidence and a concrete fix.",
    "Also name any pattern that recurs across two or more passes, with its own attribution, the ids",
    "it occurs in, and a concrete fix location. If the window has no send-backs, say so in `note`",
    "and leave `sendBacks` and `patterns` empty."
  ].join("\n")

/** A file is a trust boundary: the manifest is read and decoded before anything else, so the two nodes disagreeing about the schema fails here, not as a garbled prompt. */
const readManifest = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(
    Effect.catch((error) => Effect.fail(new WindowUnreadable({ path, detail: String(error) }))),
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (error) => new WindowUnreadable({ path, detail: String(error) })
      })
    ),
    Effect.flatMap((parsed) =>
      Schema.decodeUnknownEffect(ReviewWindowSchema)(parsed).pipe(
        Effect.catch((error) => Effect.fail(new WindowUnreadable({ path, detail: String(error) })))
      )
    )
  )

/**
 * Attributes every send-back in the next unanalysed window and renders the report. The window is
 * read as data (send-back ids to check the reply against, `through` for the report's own first
 * line); the artifacts it names are read by the session, never inlined here.
 *
 * Attribution completeness is a comparison, not a hope: a reply that leaves any blocked/dispute-rejected id
 * unattributed fails {@link AnalysisIncomplete} before the report is ever written, so the watermark
 * does not advance and the same window is re-analysed next time.
 */
export const analyseReviews = make({
  name: "analyse-reviews",
  description: "Attribute every send-back in a review window and render the pattern report.",
  input: Schema.Struct({
    manifestPath: Schema.String,
    /** A named agent from the target repo's `.claude/agents/`, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's default (no override — this is not an Effect-writing session). */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    reportPath: Schema.String,
    /** How many send-backs the reply attributed — every blocked/dispute-rejected pass in the window. */
    sendBacks: Schema.Int,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new AnalysisRunRootMissing())

      const fs = yield* FileSystem.FileSystem
      const window = yield* readManifest(fs, input.manifestPath)

      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: promptFor(window, input.manifestPath),
        jsonSchema: ANALYSIS,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const requiredIds = window.passes.filter((pass) => pass.verdict !== "clean").map((pass) => pass.id)
      const attributedIds = reply.verdict.sendBacks.map((sendBack) => sendBack.id)
      const missing = missingAttributions(requiredIds, attributedIds)
      if (missing.length > 0) return yield* Effect.fail(new AnalysisIncomplete({ missing }))

      const report = renderReport(window, reply.verdict)
      const reportPath = yield* writeArtifact(fs, runInfo.runRoot, "review-patterns", report).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new ReportWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions })
          )
        )
      )

      return {
        reportPath,
        sendBacks: reply.verdict.sendBacks.length,
        sessions: reply.sessions,
        costUsd: reply.costUsd
      }
    }).pipe(Effect.provide(platform))
})
