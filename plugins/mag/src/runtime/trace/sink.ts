import { Context, Effect, Layer } from "effect"
import type { TraceEvent } from "mag/runtime/trace/event"

/**
 * What a trace sink is — a synchronous or async callback
 * that receives one {@link TraceEvent} and returns nothing useful. A sink's
 * return value (resolved or rejected) is never awaited by the caller; see
 * {@link isolate} for why.
 */
export type TraceSink = (event: TraceEvent) => void | Promise<void>

/**
 * The registered set of trace sinks, held as a
 * `Context.Reference` so a run with nothing provided resolves to the empty
 * set rather than failing — the "no-sink baseline" every graph run has by
 * default.
 */
export const TraceSinks = Context.Reference<ReadonlySet<TraceSink>>(
  "mag/runtime/trace/TraceSinks",
  { defaultValue: () => new Set() }
)

/**
 * Register one more sink on top of whatever `TraceSinks` set is
 * already in context (the default empty set if nothing upstream provided
 * one). Reads `TraceSinks` from the *incoming* context the layer is built
 * against — `Layer.effect(TraceSinks, ...)` does not let the effect observe
 * the very value it is constructing, so this cannot recurse. Composing
 * `addSinkLayer(a)` and `addSinkLayer(b)` sequentially (e.g.
 * `addSinkLayer(b).pipe(Layer.provideMerge(addSinkLayer(a)))`) accumulates
 * both sinks into one set; composing them independently (`Layer.merge`/
 * `Layer.mergeAll`) would not, since each would only see the incoming
 * default and the merge would keep only one winner.
 */
export const addSinkLayer = (sink: TraceSink): Layer.Layer<never> =>
  Layer.effect(TraceSinks, Effect.map(TraceSinks, (existing) => new Set([...existing, sink])))

const noop = (): void => {}

/**
 * Run one sink against one event, and make certain its failure
 * — synchronous throw or a rejected promise — never escapes. This is the
 * total-isolation boundary a trace sink requires: a broken sink must not stop other
 * sinks from receiving the event, must not throw out of `emitToAll`, and
 * must not surface as a Node/Bun unhandled-rejection.
 *
 * The empty `catch`/rejection handler is deliberate, not an oversight: a
 * sink is opaque to the tracer, so once its failure is caught there is
 * nowhere meaningful left to report it — by design, it is simply swallowed.
 */
const isolate = (sink: TraceSink, event: TraceEvent): void => {
  try {
    const result = sink(event)
    if (result !== undefined && typeof result.then === "function") {
      result.then(noop, noop)
    }
  } catch {
    // Deliberate — a sink's own failure has nowhere to go.
  }
}

/**
 * Fan one event out to every sink in the set,
 * synchronously and isolated per-sink. Returns `void`, not an `Effect` —
 * this runs inside the tracer's `span()`/`end()` callbacks, which are plain
 * (non-Effect) function calls.
 */
export const emitToAll = (sinks: ReadonlySet<TraceSink>): (event: TraceEvent) => void => (event) => {
  sinks.forEach((sink) => isolate(sink, event))
}
