import { Effect, Schema } from "effect"
import { createGraphFolder } from "mag/graph-nodes/create-graph-folder/graph-node"
import { envisionMermaid } from "mag/graph-nodes/envision-mermaid/graph-node"
import { envisionRailSketch } from "mag/graph-nodes/envision-rail-sketch/graph-node"
import { make } from "mag/runtime/graph-node.definition"
import { runScopedLayers } from "mag/runtime/run-layers"

/**
 * Hardwired the same way `graphs/develop-graph/graph.ts`'s `EFFECT_AGENT` is: when we work on graph,
 * we are Effect first, and the repo's `.claude/agents/effect-expert.md` is where that stance lives.
 * Only `envision-rail-sketch` gets it; `envision-mermaid` carries no agent at all (the session default).
 */
const EFFECT_AGENT = "effect-expert"

/**
 * `create-graph-folder` → `envision-mermaid` → `envision-rail-sketch`, a straight line — no
 * conditional edges, since both dispatches always run and neither is selected by a verdict.
 * `envision-rail-sketch` receives the vision's own path rather than re-deriving it, so
 * `envision-mermaid` stays that filename's only owner (Single Source of Truth).
 */
const pipeline = (name: string) =>
  Effect.gen(function* () {
    const folder = yield* createGraphFolder.run({ name })
    const vision = yield* envisionMermaid.run({ folder: folder.folder, name })
    const sketch = yield* envisionRailSketch.run({
      folder: folder.folder,
      visionPath: vision.visionPath,
      name,
      agent: EFFECT_AGENT
    })

    return {
      folder: folder.folder,
      visionPath: vision.visionPath,
      sketchPath: sketch.sketchPath,
      // One unpriced session makes the run's figure unpriced, never silently zero — `graphs/develop-graph/graph.ts`'s own reduction.
      costUsd: [vision.costUsd, sketch.costUsd].reduce((a, b) => (a === null || b === null ? null : a + b)),
      sessions: [...vision.sessions, ...sketch.sessions]
    }
  })

/**
 * `envision`: turns a graph name into a raw mermaid vision and an effect-expert rail-sketch,
 * co-located in the graph's own source folder, beside the code they describe. Runs in the
 * primary checkout, not a worktree
 * (`worktree: false`): the maintainer reads both artifacts in the tree next to the code they shaped,
 * and a worktree run would commit them into a tree a green run then deletes. The run-scoped
 * composition root is the same as every other graph's: `runScopedLayers`
 * invoked where the name is known, the graph name occupying the run scope's ticket slot — the same
 * `isSafeSegment` gate a ticket id gets.
 */
export const envision = make({
  name: "envision",
  description: "Turn a graph name into a mermaid vision and an effect-expert rail-sketch, co-located in its own folder.",
  input: Schema.Struct({
    name: Schema.String
  }),
  success: Schema.Struct({
    folder: Schema.String,
    visionPath: Schema.String,
    sketchPath: Schema.String,
    costUsd: Schema.NullOr(Schema.Number),
    sessions: Schema.Array(Schema.String)
  }),
  run: (input) =>
    // Scoped the same way `graph()` scopes every other graph's run (`runtime/graph.ts`'s own
    // doc comment). No `records` field: `envision-mermaid`/`envision-rail-sketch` commit their
    // deliverable unconditionally, and neither node reads `recordsRoot` — they compose their paths
    // from the folder `create-graph-folder` made under `DEFAULT_GRAPHS_ROOT` — so this run scope has
    // no records policy left to carry.
    Effect.scoped(
      Effect.gen(function* () {
        const layers = yield* runScopedLayers({ ticket: input.name, graph: "envision", worktree: false })
        return yield* pipeline(input.name).pipe(Effect.provide(layers))
      })
    )
})
