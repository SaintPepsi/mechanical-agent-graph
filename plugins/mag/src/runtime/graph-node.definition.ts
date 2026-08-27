import { Effect, Schema } from "effect"
import { journaled } from "mag/runtime/journal/journaled"
import { tracedRun } from "mag/runtime/trace/boundary"

/**
 * One shape for GraphNodes and requirements. A requirement is a GraphNode
 * whose success output shapes the graph: it provides context or services
 * that other GraphNodes list in their requirements (R).
 *
 * Error codes are the E channel: one Data.TaggedError class per code,
 * exported next to the GraphNode. Every GraphNode declares at least one.
 */
export interface GraphNode<I, A, E, R> {
  readonly name: string
  readonly description: string
  readonly input: Schema.Schema<I>
  readonly success: Schema.Schema<A>
  readonly run: (input: I) => Effect.Effect<A, E, R>
  readonly notes?: string
}

/**
 * The one constructor every GraphNode goes through — a node, a phase and a graph alike, since all
 * three are this same shape (`rebuild-sketch.md`, "Graphs").
 *
 * It applies `journaled`, so a node leaves a run record by being built rather than by
 * remembering to ask. The alternative — a `journaled(make({…}))` line in each node module, emitted
 * by `mag node create`'s template — is a convention, not an invariant: it covers nodes the
 * scaffolder wrote and misses every node written by hand, written before the template changed, or
 * edited afterwards, and it misses them *silently*, with no error and no row. One constructor
 * cannot drift from itself.
 */
export const make = <I, A, E, R>(graphNode: GraphNode<I, A, E, R>): GraphNode<I, A, E, R> => journaled(graphNode)

/**
 * Decode untrusted input against the GraphNode's schema, then run it inside a marked, named span —
 * `tracedRun`, in `trace/boundary.ts`, opens the span only after this decode has already succeeded,
 * so a decode failure never opens one.
 */
export const execute = <I, A, E, R>(graphNode: GraphNode<I, A, E, R>, input: unknown) =>
  Schema.decodeUnknownEffect(graphNode.input)(input).pipe(
    Effect.flatMap((decoded) => tracedRun(graphNode, decoded))
  )
