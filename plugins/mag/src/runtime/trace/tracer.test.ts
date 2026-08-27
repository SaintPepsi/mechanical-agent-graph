import { describe, expect, test } from "bun:test"
import { Context, Data, Exit, Option, Tracer } from "effect"
import { nodeRunMarker, SUCCESS_ATTRIBUTE } from "./boundary"
import { UNTAGGED_FAILURE } from "./outcome"
import { graphTracer } from "./tracer"
import type { TraceEvent } from "./event"

class Boom extends Data.TaggedError("BOOM")<{}> {}

/** A recording `emit` plus the array it pushes into, for asserting exactly-what-was-emitted. */
const recorder = (): { readonly emit: (event: TraceEvent) => void; readonly events: Array<TraceEvent> } => {
  const events: Array<TraceEvent> = []
  return { emit: (event) => events.push(event), events }
}

/** Hand-built `Tracer.Tracer["span"]` options, matching a marked node-run span by default. */
const markedOptions = (
  overrides: Partial<Parameters<Tracer.Tracer["span"]>[0]> = {}
): Parameters<Tracer.Tracer["span"]>[0] => ({
  name: "doubles",
  parent: Option.none(),
  annotations: nodeRunMarker(Option.some("21")),
  links: [],
  startTime: 1_000_000_000n,
  kind: "internal",
  root: false,
  sampled: true,
  ...overrides
})

describe("graphTracer — marked span opens", () => {
  test("emits exactly one open event carrying name, spanId, parentSpanId, startTimeNanos, runId, input", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)

    const span = tracer.span(markedOptions())

    expect(events.length).toBe(1)
    expect(events[0]).toEqual({
      kind: "open",
      runId: "run-1",
      spanId: span.spanId,
      parentSpanId: null,
      name: "doubles",
      startTimeNanos: "1000000000",
      input: "21"
    })
  })

  test("parent Option.some(anotherSpan) → parentSpanId equals that span's spanId", () => {
    const parentSpan = new Tracer.NativeSpan({
      name: "outer",
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      startTime: 500n,
      kind: "internal",
      sampled: true
    })

    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)
    tracer.span(markedOptions({ parent: Option.some(parentSpan) }))

    expect(events[0]?.kind).toBe("open")
    expect(events[0]?.kind === "open" ? events[0].parentSpanId : undefined).toBe(parentSpan.spanId)
  })
})

describe("graphTracer — marked span closes", () => {
  test("end(endTime, Exit.succeed(v)) emits one close event: same spanId, durationNanos, outcome ok, value from SUCCESS_ATTRIBUTE", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)
    const span = tracer.span(markedOptions())
    span.attribute(SUCCESS_ATTRIBUTE, "42")

    span.end(1_500_000_000n, Exit.succeed(42))

    expect(events.length).toBe(2)
    expect(events[1]).toEqual({
      kind: "close",
      runId: "run-1",
      spanId: span.spanId,
      name: "doubles",
      endTimeNanos: "1500000000",
      durationNanos: "500000000",
      outcome: "ok",
      value: "42"
    })
  })

  test("a tagged failure → outcome fail, tag named", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)
    const span = tracer.span(markedOptions())

    span.end(2_000_000_000n, Exit.fail(new Boom()))

    const close = events[1]
    expect(close?.kind).toBe("close")
    expect(close?.kind === "close" ? close.outcome : undefined).toBe("fail")
    expect(close?.kind === "close" ? close.tag : undefined).toBe("BOOM")
  })

  test("an untagged failure → tag falls back to UNKNOWN_ERROR", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)
    const span = tracer.span(markedOptions())

    span.end(2_000_000_000n, Exit.fail({ message: "no tag" }))

    const close = events[1]
    expect(close?.kind === "close" ? close.outcome : undefined).toBe("fail")
    expect(close?.kind === "close" ? close.tag : undefined).toBe(UNTAGGED_FAILURE)
  })

  test("a defect (Exit.die) → outcome die", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)
    const span = tracer.span(markedOptions())

    span.end(2_000_000_000n, Exit.die(new Error("boom")))

    const close = events[1]
    expect(close?.kind === "close" ? close.outcome : undefined).toBe("die")
  })

  test("an interrupted exit → outcome interrupt", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)
    const span = tracer.span(markedOptions())

    span.end(2_000_000_000n, Exit.interrupt())

    const close = events[1]
    expect(close?.kind === "close" ? close.outcome : undefined).toBe("interrupt")
  })

  test("no SUCCESS_ATTRIBUTE set → ok close event carries no value field at all", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)
    const span = tracer.span(markedOptions())

    span.end(1_500_000_000n, Exit.succeed(42))

    const close = events[1]
    expect(close).toBeDefined()
    expect(close !== undefined && "value" in close).toBe(false)
  })

  test("runId is identical on the open and close event of one span", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-42", emit)
    const span = tracer.span(markedOptions())

    span.end(1_500_000_000n, Exit.succeed(1))

    expect(events[0]?.runId).toBe("run-42")
    expect(events[1]?.runId).toBe("run-42")
  })

  test("calling end twice emits only one close event total", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)
    const span = tracer.span(markedOptions())

    span.end(1_500_000_000n, Exit.succeed(1))
    span.end(1_600_000_000n, Exit.succeed(1))

    const closes = events.filter((event) => event.kind === "close")
    expect(closes.length).toBe(1)
  })
})

describe("graphTracer — unmarked span, the deciding case", () => {
  test("emits zero events at span() and zero at end(), and the returned span is still fully functional", () => {
    const { emit, events } = recorder()
    const tracer = graphTracer("run-1", emit)

    const span = tracer.span(markedOptions({ annotations: Context.empty() }))

    expect(events.length).toBe(0)

    expect(() => span.attribute("some-key", "some-value")).not.toThrow()
    expect(() => span.event("some-event", 1_100_000_000n)).not.toThrow()
    expect(() => span.end(1_500_000_000n, Exit.succeed(1))).not.toThrow()

    expect(events.length).toBe(0)
  })
})
