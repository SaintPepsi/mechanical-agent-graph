// Test harness for tracing: two independently-broken sinks registered together — one
// throws synchronously, one returns a rejected promise — and nothing else (no console sink, no
// file sink). This harness exists purely to prove `sink.ts`'s `isolate`/`emitToAll` boundary holds
// for TWO broken sinks at once: a node run through this harness must be observably identical (same
// stdout, same non-trace stderr, same exit code) to the same run through `harness-cli-no-sink.ts`.
//
// `addSinkLayer(b).pipe(Layer.provideMerge(addSinkLayer(a)))` is `sink.ts`'s own documented idiom
// for accumulating more than one sink into one `TraceSinks` set — `Layer.mergeAll`/`Layer.merge`
// would NOT accumulate them (each would only see the incoming default and the merge keeps only one
// winner), so the two sinks below are chained through `Layer.provideMerge`, not merged.
import { Layer } from "effect"
import { main } from "mag/runtime/run-cli"
import { runIdLayer, tracerLayer } from "mag/runtime/trace/layer"
import { addSinkLayer } from "mag/runtime/trace/sink"
import { fixtureRegistry } from "./fixtures/registry"

const throwingSink = addSinkLayer(() => {
  throw new Error("deliberate synchronous sink failure")
})

const rejectingSink = addSinkLayer(() => Promise.reject(new Error("deliberate async sink failure")))

const brokenSinks: Layer.Layer<never> = rejectingSink.pipe(Layer.provideMerge(throwingSink))

const tracing: Layer.Layer<never> = tracerLayer.pipe(Layer.provide(Layer.mergeAll(brokenSinks, runIdLayer)))

main(fixtureRegistry, tracing)
