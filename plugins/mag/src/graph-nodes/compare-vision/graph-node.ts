import { Effect, FileSystem, Schema } from "effect"
import { compare, FindingSchema, renderReport } from "mag/graph-nodes/compare-vision/compare"
import { CompareReportWriteFailed, CompareRunRootMissing } from "mag/graph-nodes/compare-vision/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo } from "mag/runtime/run-info"
import { readShapeAt } from "mag/runtime/vision-shape"

/**
 * Reads both drawings through the one shared reader (`runtime/vision-shape.ts`) so a parser quirk
 * cancels on both sides rather than landing as divergence, differences them with `compare` (pure,
 * this folder), and writes the report. A clean pass still writes a file: the run directory stays
 * a complete record.
 */
export const compareVision = make({
  name: "compare-vision",
  description: "Difference the shipped vision against a blind re-derivation and write the findings report.",
  input: Schema.Struct({ visionPath: Schema.String, derivedVisionPath: Schema.String }),
  success: Schema.Struct({
    reportPath: Schema.String,
    findings: Schema.Array(FindingSchema),
    divergent: Schema.Boolean
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new CompareRunRootMissing())

      const fs = yield* FileSystem.FileSystem
      const declared = yield* readShapeAt(input.visionPath)
      const derived = yield* readShapeAt(input.derivedVisionPath)

      const findings = compare(declared, derived)
      const report = renderReport(input.visionPath, input.derivedVisionPath, findings)
      const reportPath = yield* writeArtifact(fs, runInfo.runRoot, "code-to-vision", report).pipe(
        Effect.catch((error) =>
          Effect.fail(new CompareReportWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) }))
        )
      )

      // `divergent` derived once here, never recomputed by a caller.
      return { reportPath, findings, divergent: findings.length > 0 }
    }).pipe(Effect.provide(platform))
})
