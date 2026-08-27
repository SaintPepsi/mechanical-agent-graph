import { openSync, writeSync } from "node:fs"
import { Schema } from "effect"
import type { Layer } from "effect"
import { TraceEventSchema } from "mag/runtime/trace/event"
import { addSinkLayer } from "mag/runtime/trace/sink"

/**
 * A composable sink — appends one NDJSON line per event to `path`,
 * each line the event encoded through {@link TraceEventSchema} (the same schema the fold later
 * decodes with). The file descriptor is opened lazily, in append mode, on the *first write inside
 * the sink callback* — not at layer-construction time — so an unopenable path throws from
 * inside the callback that `isolate` (sink.ts) already wraps in try/catch, instead of killing the
 * CLI before any node runs. Once open, every later event reuses the same fd with a synchronous
 * `writeSync` — one open/write cycle per CLI run rather than per event. `writeSync` is synchronous,
 * so within one sink call the write order IS the event order (reads in emission order),
 * and repeated CLI runs append rather than truncate ("a" flag). Plain `node:fs`, not the Effect
 * `FileSystem` service — this runs inside the tracer's `span()`/`end()` callbacks, which are plain
 * (non-Effect) function calls; the fd closes naturally when the process exits.
 * `Schema.encodeSync` renders any `Schema.Redacted` field as the literal
 * `"<redacted>"`, so a secret never reaches the file.
 */
export const fileSinkLayer = (path: string): Layer.Layer<never> => {
  let fd: number | undefined
  return addSinkLayer((event) => {
    fd ??= openSync(path, "a")
    writeSync(fd, `${JSON.stringify(Schema.encodeSync(TraceEventSchema)(event))}\n`)
  })
}
