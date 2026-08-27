import { Context, DateTime, Effect, Layer, Tracer } from "effect"
import { consoleSinkLayer } from "mag/runtime/trace/console-sink"
import { emitToAll, TraceSinks } from "mag/runtime/trace/sink"
import { graphTracer } from "mag/runtime/trace/tracer"

/**
 * One CLI invocation = one run identifier. Held as a `Context.Reference` — like
 * `TraceSinks`, a read with nothing provided still resolves rather than failing — but the
 * `defaultValue` here is a fallback only: the actual per-process value always comes from
 * {@link runIdLayer} below, built once at the composition root, never from this default.
 */
export const RunId: Context.Reference<string> = Context.Reference<string>("mag/runtime/trace/RunId", {
  defaultValue: () => crypto.randomUUID()
})

/** The UTC instant as the 14 digits `YYYYMMDDhhmmss` — what makes a run id sort by start time. */
const stamp = (iso: string): string => iso.replace(/\D/g, "").slice(0, 14)

/**
 * Mints one run id, once, at the CLI entry's composition root — `test/run-harness.ts`
 * spawns a fresh `bun` process per invocation, so a second invocation is a second process is a
 * second id. The id is also the run directory's name under the artifact root, so it
 * must sort by start time — a UTC second-stamp does, a uuid does not. The four random hex chars
 * keep two same-second runs from sharing a journal file; within one second the order between them
 * is arbitrary, an accepted bound. `DateTime.now` reads the Clock service
 * (testable time, per Effect's own guidance); `crypto.randomUUID()` is a Web-standard global, not
 * `process.*` — `console-sink.ts`'s process-globals rule is untouched by it.
 */
export const runIdLayer: Layer.Layer<never> = Layer.effect(
  RunId,
  Effect.map(DateTime.now, (now) => `${stamp(DateTime.formatIso(now))}-${crypto.randomUUID().slice(0, 4)}`)
)

/**
 * The `Tracer.Tracer` service itself. Reads `TraceSinks` and `RunId`
 * ONCE at layer-build time — the same idiom `Logger.layer` uses for its own `Context.Reference`
 * (`node_modules/effect/src/Logger.ts`, `CurrentLoggers`) — and freezes both into the closure
 * `graphTracer` returns, so every span opened for the rest of the run reuses the same run id and
 * the same sink set rather than re-reading context per span.
 */
export const tracerLayer: Layer.Layer<never> = Layer.effect(
  Tracer.Tracer,
  Effect.gen(function* () {
    const sinks = yield* TraceSinks
    const runId = yield* RunId
    return graphTracer(runId, emitToAll(sinks))
  })
)

/**
 * The default, always-on composition wired at the CLI entry (`run-cli.ts`'s `main`)
 * — console sink only, no file sink; nothing else composes this yet. `Layer.provide` builds
 * `consoleSinkLayer` first and feeds its output into `tracerLayer`'s requirements, so the
 * `TraceSinks` read inside `tracerLayer` sees the provided value rather than the bare
 * `Context.Reference` default.
 *
 * `runIdLayer` rides `Layer.provideMerge`, not `Layer.provide` — the minted id both
 * feeds `tracerLayer`'s own read AND stays in the layer's output, so everything downstream of
 * `main`'s `Effect.provide(tracing)` (the journal wiring above all, `run-layers.ts`) reads the
 * same id instead of falling back to `RunId`'s per-read default. One mint, two records; a second
 * `Effect.provide` minting a second uuid was exactly the trap this closes.
 */
export const tracingLayer: Layer.Layer<never> = tracerLayer.pipe(
  Layer.provide(consoleSinkLayer),
  Layer.provideMerge(runIdLayer)
)
