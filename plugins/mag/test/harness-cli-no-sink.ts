// Test harness: the no-sink baseline. Provides `tracerLayer` and `runIdLayer` but
// registers no sink at all — no `addSinkLayer` call anywhere in this file — so `TraceSinks`
// resolves to its bare `Context.Reference` default, the empty set (`sink.ts`'s
// `defaultValue: () => new Set()`). Every sink-parity test compares this harness's
// stdout/stderr/exit-code against a sink-bearing harness's, to prove tracing changes nothing
// observable about a node run beyond the `mag:` lines a sink happens to render.
import { Layer } from "effect"
import { main } from "mag/runtime/run-cli"
import { runIdLayer, tracerLayer } from "mag/runtime/trace/layer"
import { fixtureRegistry } from "./fixtures/registry"

const tracing: Layer.Layer<never> = tracerLayer.pipe(Layer.provide(runIdLayer))

main(fixtureRegistry, tracing)
