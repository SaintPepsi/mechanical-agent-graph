// Test harness: registers `nestedNodeFixture()` — an outer GraphNode whose `run`
// calls `execute()` on an inline inner GraphNode — behind a tracer composed with a FILE sink, so a
// subprocess test can read back both node runs' events and check the inner's `parentSpanId` names
// the outer's `spanId`. The console line carries no span id by design (its templates are fixed), so
// only the file sink makes that assertion possible.
//
// The file path is an env var read HERE, in the harness entry, never in `src/runtime/`: there is no
// `--trace-file` flag. `GRAPH_TRACE_FILE` has a local-dev fallback so this harness still
// runs standalone without a test spawning it, but the test itself always sets the env var to a
// `tmpdir()`-based path before spawning — never a path under `plugins/mag/` (`cli.test.ts`'s
// whole-tree snapshot check would otherwise red on a stray trace file).
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Layer } from "effect"
import { main } from "mag/runtime/run-cli"
import { fileSinkLayer } from "mag/runtime/trace/file-sink"
import { runIdLayer, tracerLayer } from "mag/runtime/trace/layer"
import { nestedNodeFixture } from "mag/test/node-fixture"

const path = process.env.GRAPH_TRACE_FILE ?? join(tmpdir(), "graph-nested-trace.ndjson")

const tracing: Layer.Layer<never> = tracerLayer.pipe(Layer.provide(Layer.mergeAll(fileSinkLayer(path), runIdLayer)))

main([{ kind: "command", node: nestedNodeFixture() }], tracing)
