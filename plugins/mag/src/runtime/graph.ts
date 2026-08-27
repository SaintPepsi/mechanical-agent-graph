import { Effect, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { type RunScope, runScopedLayers } from "mag/runtime/run-layers"

/**
 * A graph is already a GraphNode by construction — this is the one constructor that makes
 * that composable instead of merely nominal. `scope` is a graph's own declaration of what starts a
 * run of it (`RunScope`, `run-layers.ts`); `pipeline` is its body, run under the layers that scope
 * mints, so a graph is journalled and traced exactly like any other node and `.run()` is the only
 * way to start one, at any depth.
 *
 * A subgraph's declared `scope` is inert while borrowed: `runScopedLayers` is idempotent under
 * nesting (`RunScoped`, `run-layers.ts`), so the host's execution shape wins by construction, not by
 * the borrowing site remembering to skip anything. `scope` is a constructor argument, not a field on
 * the returned value, so a graph stays exactly the plain `GraphNode` shape `make` already returns:
 * no second callable surface to grow dependents (Hyrum's Law).
 *
 * Deliberately its own file, not beside `make` in `graph-node.definition.ts`: `runScopedLayers`
 * reaches `Shell` (`Bun.spawn`), and `graph-node.definition.ts` is what every plain node's `make`
 * import resolves through — `create.test.ts`'s scaffold probe typechecks a fresh node's
 * `graph-node.ts` with no Bun types configured, on purpose, so a node never has to know Bun exists.
 * Importing `run-layers.ts` from `graph-node.definition.ts` would have pulled that dependency into
 * every node's closure.
 *
 * `Effect.scoped` wraps the whole thing, layer build and pipeline alike: `runScopedLayers`'
 * foreign-run-root branch mints its records directory with `fs.makeTempDirectoryScoped`, deliberately
 * leaving `Scope` in its own R so a caller decides the directory's lifetime — this is that decision.
 * The scope opens before the layers are built and closes only once `pipeline` has finished, success
 * or failure, so the directory survives for exactly as long as the run that uses it and is removed
 * either way. A composed subgraph opens its own nested scope the
 * same way, but mints nothing under it — `RunScoped` (`run-layers.ts`) makes its own `runScopedLayers`
 * call a no-op when a host graph already has one running.
 */
export const graph = <I, A, E, R>(options: {
  readonly name: string
  readonly description: string
  readonly input: Schema.Schema<I>
  readonly success: Schema.Schema<A>
  readonly notes?: string
  readonly scope: (input: I) => RunScope
  readonly pipeline: (input: I) => Effect.Effect<A, E, R>
}) =>
  make({
    name: options.name,
    description: options.description,
    input: options.input,
    success: options.success,
    notes: options.notes,
    run: (input: I) =>
      Effect.scoped(
        runScopedLayers(options.scope(input)).pipe(
          Effect.flatMap((layers) => options.pipeline(input).pipe(Effect.provide(layers)))
        )
      )
  })
