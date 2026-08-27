import { Context, Effect, Option } from "effect"
import type { GraphNode } from "mag/runtime/graph-node.definition"
import { encodeBestEffort } from "mag/runtime/schema-codec"

/**
 * The marker payload carried by a span's annotations when that span is a node run —
 * its `input`, encoded best-effort (`None` when the node's input schema can't re-encode the decoded
 * value — never a failure).
 */
export interface NodeRun {
  readonly input: Option.Option<unknown>
}

/**
 * The reference a span's `annotations` are checked against to decide "is this span a
 * node run" — its `Some`-ness IS the marker, nothing else decides this. Defaults to `Option.none()`
 * so every span that isn't opened by `tracedRun` below (a library's own internal span, for instance)
 * reads as "not a node run" with no special-casing required at the read site.
 */
export const NodeRunAnnotation: Context.Reference<Option.Option<NodeRun>> = Context.Reference(
  "mag/runtime/trace/NodeRunAnnotation",
  { defaultValue: () => Option.none() }
)

/** Builds the annotations context that marks a span as a node run, carrying its best-effort encoded input. */
export const nodeRunMarker = (input: Option.Option<unknown>): Context.Context<never> =>
  Context.make(NodeRunAnnotation, Option.some({ input }))

/**
 * Reads the node-run marker back off a span's annotations. Total — `NodeRunAnnotation`
 * is a `Context.Reference` and always resolves (to `Option.none()` when absent), so there is no
 * `Option`-of-`Option` handling needed beyond the marker's own `None`/`Some`.
 */
export const nodeRunOf = (annotations: Context.Context<never>): Option.Option<NodeRun> =>
  Context.get(annotations, NodeRunAnnotation)

/**
 * The span attribute key a node's best-effort encoded success value is recorded
 * under. The tracer reads this same constant off a span's `attributes` — defined
 * once here so nobody re-spells it.
 */
export const SUCCESS_ATTRIBUTE = "graph.node.success"

/**
 * Runs a `GraphNode`'s `run` inside a span marked as a node run
 * (`nodeRunMarker`), opened only after `execute`'s own decode has already succeeded — a decode
 * failure never reaches here, so it never opens a span. The span's marker carries the
 * node's input, encoded best-effort: an encode failure becomes `None`, never a failure of the
 * returned effect, so a node whose decoded input can't be re-encoded still runs and still
 * succeeds. On a successful run, the success value is likewise encoded best-effort and, only when
 * that encode succeeds, annotated onto the span under `SUCCESS_ATTRIBUTE`; a failing run's span
 * carries no such attribute.
 */
export const tracedRun = <I, A, E, R>(graphNode: GraphNode<I, A, E, R>, decoded: I) =>
  encodeBestEffort(graphNode.input, decoded).pipe(
    Effect.flatMap((encodedInput) =>
      graphNode.run(decoded).pipe(
        Effect.tap((value) =>
          encodeBestEffort(graphNode.success, value).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (encoded) => Effect.annotateCurrentSpan(SUCCESS_ATTRIBUTE, encoded)
              })
            )
          )
        ),
        Effect.withSpan(graphNode.name, { annotations: nodeRunMarker(encodedInput) })
      )
    )
  )
