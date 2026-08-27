import { Effect, type Option } from "effect"
import type { GraphNode } from "mag/runtime/graph-node.definition"

/**
 * The success shape a GraphNode must have to gate a `when` — `matched` is all `when` reads,
 * so a probe is free to carry its own evidence alongside it.
 */
export interface Verdict {
  readonly matched: boolean
}

/**
 * Pairs a probe with the node it guards, so a run-condition reads as one declaration rather than an
 * `if` wrapped around `node.run` at the call site. Built on `Effect.when`'s data-first overload:
 * the probe runs first and its verdict is always journalled, then the guarded node's effect is
 * entered only when `matched` — `Effect.when` never touches `node.run`'s result unless the
 * condition resolved `true`, so a skipped node never reaches `journaled`'s appends and leaves no
 * row.
 * Mints no error of its own: the union stays exactly what the probe and the node already produce,
 * because closed error unions stay closed.
 */
export const when = <PI, PV extends Verdict, PE, PR, I, A, E, R>(
  probe: GraphNode<PI, PV, PE, PR>,
  node: GraphNode<I, A, E, R>
) =>
(input: { readonly probe: PI; readonly node: I }): Effect.Effect<Option.Option<A>, PE | E, PR | R> =>
  Effect.when(node.run(input.node), Effect.map(probe.run(input.probe), (verdict) => verdict.matched))
