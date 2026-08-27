import { Effect, Schema } from "effect"
import { analyseReviews } from "mag/graph-nodes/analyse-reviews/graph-node"
import { commentTicket } from "mag/graph-nodes/comment-ticket/graph-node"
import { gatherReviews } from "mag/graph-nodes/gather-reviews/graph-node"
import { graph } from "mag/runtime/graph"

const WINDOW_SIZE = 5 // the count that fires an analysis
const ANALYSIS_EPOCH = "2026-08-20T00:00:00.000Z" // the floor for the first window: review passes recorded before this are out of scope
const MODEL_ANALYSIS = "opus" // judgment-heavy work gets the stronger model

/**
 * Straight-line composition, per `PRINCIPLES.md`'s "Graphs read straight-line": the gate is
 * `gather-reviews`'s own `WindowNotFull`, an edge in the error channel, so there is no branch to
 * draw here.
 */
const pipeline = (ticket: string) =>
  Effect.gen(function* () {
    const window = yield* gatherReviews.run({ size: WINDOW_SIZE, epoch: ANALYSIS_EPOCH })
    const analysed = yield* analyseReviews.run({ manifestPath: window.manifestPath, model: MODEL_ANALYSIS })
    yield* commentTicket.run({ ticket, path: analysed.reportPath })

    return {
      ticket,
      manifestPath: window.manifestPath,
      reportPath: analysed.reportPath,
      passes: window.passes,
      sendBacks: analysed.sendBacks,
      through: window.through,
      sessions: analysed.sessions,
      costUsd: analysed.costUsd
    }
  })

/**
 * Closes the loop a review send-back leaves open. Every 5 review passes across every run on
 * this machine, gather them mechanically, spend one session attributing each send-back, and post
 * the pattern report as a tracker comment.
 *
 * `worktree: false`: this graph writes no code and moves no HEAD. It reads other runs' records
 * under `~/.claude/graph/**` and its one session reads this checkout to attribute what it finds;
 * neither needs a worktree of its own.
 */
export const reviewPatternGraph = graph({
  name: "review-pattern-graph",
  description: "Every 5 review passes, attribute the send-backs and comment the report on the ticket.",
  input: Schema.Struct({
    /** Which ticket the report lands on — this graph has no default; callers set it explicitly. */
    reportTicket: Schema.String
  }),
  success: Schema.Struct({
    ticket: Schema.String,
    manifestPath: Schema.String,
    reportPath: Schema.String,
    passes: Schema.Int,
    sendBacks: Schema.Int,
    through: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  scope: (input) => ({ ticket: input.reportTicket, graph: "review-pattern-graph", worktree: false }),
  pipeline: (input) => pipeline(input.reportTicket)
})
