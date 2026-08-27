import type { Layer } from "effect"
import type { CloseEvent, OpenEvent, Outcome, TraceEvent } from "mag/runtime/trace/event"
import { UNTAGGED_FAILURE } from "mag/runtime/trace/outcome"
import { addSinkLayer } from "mag/runtime/trace/sink"

/** Nanoseconds (decimal string, per `event.ts`) → seconds, one decimal place, always. No minutes format — a duration over sixty seconds still renders as e.g. `90.0s`. */
export const formatSeconds = (nanos: string): string => `${(Number(nanos) / 1e9).toFixed(1)}s`

const formatOpenLine = (event: OpenEvent): string => `mag: [${event.name}] entered`

/**
 * One row per {@link Outcome} — a fifth outcome is a new row here, not a new
 * branch. `ok`/`interrupt` ignore the tag; `fail`/`die` fall back to {@link UNTAGGED_FAILURE}
 * when the close event carries none: `die` follows the same `FAIL`-style
 * template as `fail`, spelled `DIE`; `interrupt` never had a tag to begin with.
 */
const CLOSE_LINE: Record<Outcome, (name: string, tag: string | undefined, seconds: string) => string> = {
  ok: (name, _tag, seconds) => `mag: [${name}] ok ${seconds}`,
  fail: (name, tag, seconds) => `mag: [${name}] FAIL ${tag ?? UNTAGGED_FAILURE} ${seconds}`,
  die: (name, tag, seconds) => `mag: [${name}] DIE ${tag ?? UNTAGGED_FAILURE} ${seconds}`,
  interrupt: (name, _tag, seconds) => `mag: [${name}] INTERRUPT ${seconds}`
}

const formatCloseLine = (event: CloseEvent): string =>
  CLOSE_LINE[event.outcome](event.name, event.tag, formatSeconds(event.durationNanos))

/** Pure formatter, one readable `mag:`-prefixed line per event — open or close. */
export const formatEventLine = (event: TraceEvent): string =>
  event.kind === "open" ? formatOpenLine(event) : formatCloseLine(event)

/**
 * The default console sink — writes one line per event to `process.stderr`
 * only, never `process.stdout`: stdout stays the node's one JSON
 * success line, and nothing else. Owns `process.stderr`; see the process-boundary comment in
 * `render.ts`.
 */
export const consoleSinkLayer: Layer.Layer<never> = addSinkLayer((event) => {
  process.stderr.write(`${formatEventLine(event)}\n`)
})
