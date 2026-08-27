// Test harness: composes BOTH the console sink and the file sink together — the
// case that proves two independently-composed sinks each receive every event of one CLI
// invocation, not just one or the other. Console lines land on `process.stderr` as normal (see
// `console-sink.ts`); file events land at a path read from `GRAPH_TRACE_FILE`, read HERE in the
// harness entry, never in `src/runtime/`: there is no `--trace-file` flag, same as
// `harness-cli-nested.ts`.
//
// The env var has a local-dev fallback so this harness still runs standalone without a test
// spawning it, but every test that spawns it sets `GRAPH_TRACE_FILE` to a fresh `tmpdir()`
// path before spawning — never a path under `plugins/mag/` (`cli.test.ts`'s whole-tree snapshot
// check would otherwise red on a stray trace file).
//
// `consoleSinkLayer` and `fileSinkLayer(path)` are two independent `addSinkLayer` layers, each
// only seeing the incoming default (empty) `TraceSinks` set — `Layer.mergeAll`-ing them does NOT
// accumulate both sinks into one set, it keeps only one winner (`sink.ts`'s own documented
// warning). They are chained through `Layer.provideMerge` instead, the same idiom
// `harness-cli-broken-sink.ts` uses for its own two sinks.
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Layer } from "effect"
import { main } from "mag/runtime/run-cli"
import { consoleSinkLayer } from "mag/runtime/trace/console-sink"
import { fileSinkLayer } from "mag/runtime/trace/file-sink"
import { runIdLayer, tracerLayer } from "mag/runtime/trace/layer"
import { fixtureRegistry } from "./fixtures/registry"

const path = process.env.GRAPH_TRACE_FILE ?? join(tmpdir(), "graph-tracing-trace.ndjson")

const sinks: Layer.Layer<never> = fileSinkLayer(path).pipe(Layer.provideMerge(consoleSinkLayer))

const tracing: Layer.Layer<never> = tracerLayer.pipe(Layer.provide(Layer.mergeAll(sinks, runIdLayer)))

main(fixtureRegistry, tracing)
