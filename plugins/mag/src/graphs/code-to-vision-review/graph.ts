import { Effect, FileSystem, Schema } from "effect"
import { FindingSchema } from "mag/graph-nodes/compare-vision/compare"
import { compareVision } from "mag/graph-nodes/compare-vision/graph-node"
import { deriveVision } from "mag/graph-nodes/derive-vision/graph-node"
import { stageShippedGraph } from "mag/graph-nodes/stage-shipped-graph/graph-node"
import { graph } from "mag/runtime/graph"
import { platform } from "mag/runtime/platform"

/**
 * `codeRoot` is scratch with exactly one reader, `derive-vision`'s dispatched session; once
 * `compare-vision` has read the drawing there is nothing left to reach it, run succeeded or failed.
 * Nothing downstream of `stage-shipped-graph` owns removal on its own, so this function does it
 * explicitly. Removal failure is ignored, `create/scaffold.ts`'s own precedent — a cleanup that
 * fails must never replace the real error with an inaccurate one.
 */
const removeCodeRoot = (codeRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(codeRoot, { recursive: true }).pipe(Effect.ignore)
  }).pipe(Effect.provide(platform))

/**
 * `stage-shipped-graph` → `derive-vision` → `compare-vision`, a straight line: a mechanical step
 * pins the shipped graph and withholds its vision, a model step draws the railway from the code
 * alone, a mechanical step differences the two drawings and writes the report. No branch: every run
 * of this graph takes the same three steps regardless of what the comparison finds — divergence is
 * a success value, never a fork in the pipeline.
 *
 * `sessions`/`costUsd` come from `derive-vision` alone: it is the only one of the three steps that
 * dispatches an agent (`stage-shipped-graph` and `compare-vision` are both mechanical), so there is
 * nothing else to sum. `graphs/envision/graph.ts`'s null-poisoning reduce exists for a graph with
 * more than one costed step; carrying it here over a single term would restate what `derive-vision`'s
 * own success already states.
 */
const pipeline = (input: { readonly name: string }) =>
  Effect.gen(function* () {
    const staged = yield* stageShippedGraph.run({ name: input.name })

    return yield* Effect.gen(function* () {
      const derived = yield* deriveVision.run({ codeRoot: staged.codeRoot, graphRoot: staged.graphRoot })
      const compared = yield* compareVision.run({
        visionPath: staged.visionPath,
        derivedVisionPath: derived.derivedVisionPath
      })

      return {
        name: input.name,
        visionPath: staged.visionPath,
        derivedVisionPath: derived.derivedVisionPath,
        reportPath: compared.reportPath,
        findings: compared.findings,
        divergent: compared.divergent,
        sessions: derived.sessions,
        costUsd: derived.costUsd
      }
    }).pipe(Effect.ensuring(removeCodeRoot(staged.codeRoot)))
  })

/**
 * `code-to-vision-review`: a session blind to a shipped graph's own vision re-derives one from its
 * code alone, and the two drawings are differenced. Reads the primary checkout and writes nothing
 * into it — `stage-shipped-graph` copies into an OS temp directory rather than mutating the tree —
 * so `worktree: false`, `graphs/envision/graph.ts`'s own reasoning for the same field.
 */
export const codeToVisionReview = graph({
  name: "code-to-vision-review",
  description: "Re-derive a shipped graph's vision from its code alone and report every structural divergence.",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({
    name: Schema.String,
    visionPath: Schema.String,
    derivedVisionPath: Schema.String,
    reportPath: Schema.String,
    findings: Schema.Array(FindingSchema),
    divergent: Schema.Boolean,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  scope: (input) => ({ ticket: input.name, graph: "code-to-vision-review", worktree: false }),
  pipeline
})
