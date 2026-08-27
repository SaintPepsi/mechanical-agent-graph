import { Exit, Option, Tracer } from "effect"
import type { NodeRun } from "mag/runtime/trace/boundary"
import { nodeRunOf, SUCCESS_ATTRIBUTE } from "mag/runtime/trace/boundary"
import type { CloseEvent, OpenEvent, TraceEvent } from "mag/runtime/trace/event"
import { outcomeOf } from "mag/runtime/trace/outcome"

/** The options `Tracer.Tracer["span"]` receives — named locally since the interface declares them inline. */
type SpanOptions = Parameters<Tracer.Tracer["span"]>[0]

/**
 * A span that IS a node run — its options carried the marker
 * `nodeRunOf` reads (`boundary.ts`'s `tracedRun`). Emits its open event at construction and, on
 * the first `end()` only (exactly one open, exactly one close per node run), its close
 * event.
 */
class TracedSpan extends Tracer.NativeSpan {
  constructor(
    options: SpanOptions,
    private readonly runId: string,
    private readonly nodeRun: NodeRun,
    private readonly emit: (event: TraceEvent) => void
  ) {
    super(options)
    const base = {
      kind: "open" as const,
      runId,
      spanId: this.spanId,
      parentSpanId: Option.match(this.parent, { onNone: () => null, onSome: (parent) => parent.spanId }),
      name: this.name,
      startTimeNanos: this.startTime.toString()
    }
    const open: OpenEvent = Option.isSome(this.nodeRun.input) ? { ...base, input: this.nodeRun.input.value } : base
    this.emit(open)
  }

  /**
   * Builds and emits the close event exactly once — guarded on
   * `status._tag` read before delegating to `NativeSpan.end`, which is what actually flips it to
   * `"Ended"` — then always calls through so the span's own lifecycle still completes on a
   * second `end()` call, same as an untraced span.
   */
  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag !== "Ended") {
      const base = {
        kind: "close" as const,
        runId: this.runId,
        spanId: this.spanId,
        name: this.name,
        endTimeNanos: endTime.toString(),
        durationNanos: (endTime - this.startTime).toString(),
        ...outcomeOf(exit)
      }
      const close: CloseEvent = this.attributes.has(SUCCESS_ATTRIBUTE)
        ? { ...base, value: this.attributes.get(SUCCESS_ATTRIBUTE) }
        : base
      this.emit(close)
    }
    super.end(endTime, exit)
  }
}

/**
 * The tracer wired at the CLI entry — only spans marked as a node run (via
 * `tracedRun`'s marker, read through `nodeRunOf`) emit events; every other span, e.g. one a
 * library opens on its own, behaves exactly as the default native tracer and emits nothing.
 */
export const graphTracer = (runId: string, emit: (event: TraceEvent) => void): Tracer.Tracer =>
  Tracer.make({
    span: (options) =>
      Option.match(nodeRunOf(options.annotations), {
        onNone: () => new Tracer.NativeSpan(options),
        onSome: (nodeRun) => new TracedSpan(options, runId, nodeRun, emit)
      })
  })
