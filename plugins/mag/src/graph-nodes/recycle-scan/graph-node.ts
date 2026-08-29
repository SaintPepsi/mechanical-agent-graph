import { Effect, FileSystem, Schema } from "effect"
import {
  RecycleScanDesignUnreadable,
  RecycleScanFileUnreadable,
  RecycleScanGitFailed,
  RecycleScanWriteFailed
} from "mag/graph-nodes/recycle-scan/errors"
import { backtickedNames, caseVariants, hitsIn, renderScan, type ScanRow } from "mag/graph-nodes/recycle-scan/scan"
import { gitReadRaw } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { requireRunRoot } from "mag/runtime/records"
import { nulPaths } from "mag/runtime/rulings"
import { RunInfo, workdir } from "mag/runtime/run-info"

/** The scan's one artifact, overwritten in place by a re-scan of a changed design, `records.ts`'s copy naming rather than `artifact.ts`'s numbered one: the plan reads the latest scan, never a history. */
const SCAN_FILE = "recycle-scan.md"

/** `""` means "inherit the process's cwd" (`run-info.ts`'s own contract), so paths concatenate rather than `Path.join`, `manifest.ts`'s precedent. */
const under = (cwd: string | undefined, path: string): string => (cwd === undefined ? path : `${cwd}/${path}`)

/**
 * A mechanical reuse probe, no agent, no model session: every backticked name in the design,
 * grepped across the files git tracks in the run's tree, as written and in kebab, camel and snake
 * case, filename and content matches alike, written as one table the plan cites. The one judgment
 * its model predecessor made (which hit is reuse and which is module-private) was its one measured
 * error; its one win was the grep, so the grep is all that remains, and the plan judges.
 *
 * `git ls-files` rather than a directory walk so an untracked or ignored file never counts as
 * prior art, `rulings.ts`'s reasoning. A file that reads as binary (a NUL byte) has no lines to
 * cite and is skipped; one git tracks but the tree cannot read fails named, since the scan cannot
 * say whether the checkout or the index is right.
 */
export const recycleScan = make({
  name: "recycle-scan",
  description: "Grep the repo for every backticked name in the design, in kebab, camel and snake case, with no agent.",
  input: Schema.Struct({ designPath: Schema.String }),
  success: Schema.Struct({ recycleScanPath: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      const scanPath = `${runInfo.runRoot}/${SCAN_FILE}`
      yield* requireRunRoot(() => new RecycleScanWriteFailed({ path: scanPath, detail: "run root missing" }))

      const fs = yield* FileSystem.FileSystem
      const design = yield* fs.readFileString(input.designPath).pipe(
        Effect.mapError((error) => new RecycleScanDesignUnreadable({ path: input.designPath, detail: String(error) }))
      )
      const names = backtickedNames(design).map((name) => ({ name, variants: caseVariants(name) }))

      const paths = yield* gitReadRaw(["git", "ls-files", "-z"], cwd, (fields) => new RecycleScanGitFailed(fields)).pipe(Effect.map(nulPaths))
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs.readFileString(under(cwd, path)).pipe(
            Effect.map((text) => ({ path, text })),
            Effect.mapError((error) => new RecycleScanFileUnreadable({ path, detail: String(error) }))
          ),
        { concurrency: 16 }
      )
      const readable = files.filter((file) => !file.text.includes("\0"))

      const rows: readonly ScanRow[] = names.map(({ name, variants }) => ({
        name,
        hits: readable.flatMap((file) => hitsIn(file.path, file.text, variants))
      }))

      yield* fs.writeFileString(scanPath, renderScan(input.designPath, rows)).pipe(
        Effect.mapError((error) => new RecycleScanWriteFailed({ path: scanPath, detail: String(error) }))
      )
      return { recycleScanPath: scanPath }
    }).pipe(Effect.provide(platform))
})
