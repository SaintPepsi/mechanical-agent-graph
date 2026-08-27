import { Effect, Schema } from "effect"
import { stageGraph } from "mag/graph-nodes/stage-shipped-graph/stage"
import { make } from "mag/runtime/graph-node.definition"
import { DEFAULT_GRAPHS_ROOT, DEFAULT_SRC_ROOT } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"

/**
 * The staging half of shipping a graph. `stageGraph` (`stage.ts`) carries the whole job over
 * parametrized roots; this node's only addition is hardwiring the live ones. No run-root gate: this
 * node reads and writes nothing under `runInfo.runRoot` (`codeRoot` is an OS temp directory,
 * `stage.ts`), so it has no precondition of its own to prove; `derive-vision` and `compare-vision`
 * each gate on the run root they actually write into — a gate held here would only prove scope on
 * another node's behalf.
 */
export const stageShippedGraph = make({
  name: "stage-shipped-graph",
  description: "Resolve a shipped graph's source and vision, then copy its tree with every vision withheld.",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({
    codeRoot: Schema.String,
    graphRoot: Schema.String,
    visionPath: Schema.String
  }),
  run: (input) =>
    stageGraph({
      graphsRoot: DEFAULT_GRAPHS_ROOT,
      srcRoot: DEFAULT_SRC_ROOT,
      name: input.name
    }).pipe(Effect.provide(platform))
})
