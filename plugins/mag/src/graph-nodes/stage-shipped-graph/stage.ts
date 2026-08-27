import { Effect, FileSystem, Path } from "effect"
import { RAIL_SKETCH_FILENAME } from "mag/graph-nodes/envision-rail-sketch/graph-node"
import { VISION_FILENAME } from "mag/graph-nodes/envision-mermaid/graph-node"
import {
  GraphSourceMissing,
  ShippedVisionMissing,
  StageFailed,
  VisionNotWithheld
} from "mag/graph-nodes/stage-shipped-graph/errors"
import { readShapeAt } from "mag/runtime/vision-shape"

/** Withheld from the staged copy: every co-located vision or rail-sketch, not just the reviewed
 * graph's own — no graph's answer is reachable from inside the derivation's working directory.
 * `fs.readDirectory(recursive)` returns each hit already relative to the root it was asked to list,
 * `ps.ts`'s `scanRoot` precedent. */
const isWithheldDoc = (relativePath: string): boolean => {
  const filename = relativePath.split("/").at(-1)
  return filename === VISION_FILENAME || filename === RAIL_SKETCH_FILENAME
}

/**
 * The whole staging job — `create-graph-folder/folder.ts`'s own precedent for keeping a node's roots
 * as parameters rather than closed over. `graphsRoot`/`srcRoot` travel as data so this stays testable
 * against a disposable fixture tree; `graph-node.ts` is the only caller that hardwires the live
 * `DEFAULT_GRAPHS_ROOT`/`DEFAULT_SRC_ROOT`. Resolves the graph's source and vision, proves the vision
 * holds a readable railway, copies the source tree with every vision and rail-sketch withheld, then
 * proves the reviewed graph's own copy lost its vision. `codeRoot` is not this function's to remove:
 * the caller owns its lifetime and its removal (`graphs/code-to-vision-review/graph.ts`).
 */
export const stageGraph = (params: {
  readonly graphsRoot: string
  readonly srcRoot: string
  readonly name: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const shippedGraphRoot = path.join(params.graphsRoot, params.name)
    const graphSourcePath = path.join(shippedGraphRoot, "graph.ts")
    if (!(yield* fs.exists(graphSourcePath))) {
      return yield* Effect.fail(new GraphSourceMissing({ name: params.name, looked: graphSourcePath }))
    }

    const visionPath = path.join(shippedGraphRoot, VISION_FILENAME)
    if (!(yield* fs.exists(visionPath))) {
      return yield* Effect.fail(new ShippedVisionMissing({ name: params.name, searchedIn: shippedGraphRoot }))
    }

    // The cheap gate: the shape itself is discarded, `compare-vision` re-reads the file
    // at its own trust boundary. This call exists only to stop the review on an unreadable vision
    // before any session is dispatched — the file's existence was just proven above, so a read
    // failure here is a real I/O problem, not the missing-file case.
    yield* readShapeAt(visionPath)

    // Not `<runRoot>/code-only`: `runRoot` lives under `~/.claude/**`, where Claude Code's
    // sensitive-file guard refuses an agent's own `Write` tool (`design/graph-node.ts`'s own reasoning), and this
    // graph's own `worktree: false` scope (`graphs/code-to-vision-review/graph.ts`) forbids writing
    // into the primary checkout either. An OS temp directory is the one place left that is neither:
    // the destination moves rather than the write. One
    // copy per run, not `writeArtifact`'s numbered-pass naming: every downstream node in this run
    // reads that one path.
    const codeRoot = yield* fs.makeTempDirectory({ prefix: "code-only-" }).pipe(
      Effect.catch((error) => Effect.fail(new StageFailed({ from: params.srcRoot, to: "", detail: String(error) })))
    )
    const onStageFailure = (error: unknown) =>
      Effect.fail(new StageFailed({ from: params.srcRoot, to: codeRoot, detail: String(error) }))

    yield* fs.copy(params.srcRoot, codeRoot).pipe(Effect.catch(onStageFailure))

    const entries = yield* fs.readDirectory(codeRoot, { recursive: true }).pipe(Effect.catch(onStageFailure))
    yield* Effect.forEach(
      entries.filter(isWithheldDoc),
      (relative) => fs.remove(path.join(codeRoot, relative)).pipe(Effect.catch(onStageFailure)),
      { concurrency: "unbounded" }
    )

    const graphRoot = path.join(codeRoot, "graphs", params.name)
    const stagedVisionPath = path.join(graphRoot, VISION_FILENAME)
    if (yield* fs.exists(stagedVisionPath)) {
      return yield* Effect.fail(new VisionNotWithheld({ stagedVisionPath }))
    }

    return { codeRoot, graphRoot, visionPath }
  })
