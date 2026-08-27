import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import type { CloseEvent } from "./event"
import { addSinkLayer, emitToAll, TraceSinks } from "./sink"
import type { TraceSink } from "./sink"

const event: CloseEvent = {
  kind: "close",
  runId: "run-1",
  spanId: "span-1",
  name: "example-node",
  endTimeNanos: "2000000000",
  durationNanos: "1000000000",
  outcome: "ok"
}

/** A sink that records every event it receives, in order. */
const recordingSink = (): { readonly sink: TraceSink; readonly received: Array<CloseEvent> } => {
  const received: Array<CloseEvent> = []
  return { sink: (e) => void received.push(e as CloseEvent), received }
}

describe("emitToAll", () => {
  test("both sinks in the set receive the same event", () => {
    const a = recordingSink()
    const b = recordingSink()
    const sinks = new Set<TraceSink>([a.sink, b.sink])

    emitToAll(sinks)(event)

    expect(a.received).toEqual([event])
    expect(b.received).toEqual([event])
  })

  test("a sink that throws synchronously does not stop the other sink, and emitToAll itself does not throw", () => {
    const throwing: TraceSink = () => {
      throw new Error("boom")
    }
    const ok = recordingSink()
    const sinks = new Set<TraceSink>([throwing, ok.sink])

    expect(() => emitToAll(sinks)(event)).not.toThrow()
    expect(ok.received).toEqual([event])
  })

  test("a sink returning a rejected promise does not throw, the other sink still receives the event, and no unhandled rejection reaches the process", async () => {
    let unhandled = false
    const onUnhandledRejection = () => {
      unhandled = true
    }
    process.on("unhandledRejection", onUnhandledRejection)

    try {
      const rejecting: TraceSink = () => Promise.reject(new Error("async boom"))
      const ok = recordingSink()
      const sinks = new Set<TraceSink>([rejecting, ok.sink])

      expect(() => emitToAll(sinks)(event)).not.toThrow()
      expect(ok.received).toEqual([event])

      // Let the rejected-promise microtask (and any unhandledRejection dispatch) settle before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unhandled).toBe(false)
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }
  })
})

describe("TraceSinks", () => {
  test("with nothing provided, resolves to the empty set", () => {
    const result = Effect.runSync(TraceSinks)

    expect(result.size).toBe(0)
  })

  test("addSinkLayer(a) composed with addSinkLayer(b) yields a TraceSinks set containing both", () => {
    const a: TraceSink = () => {}
    const b: TraceSink = () => {}

    // Sequential composition: b's layer must be built against a context that already
    // contains a's contribution, so the accumulating set carries both. Layer.mergeAll/merge
    // build layers independently against the *incoming* context, so they would each only see
    // the default empty set — Layer.provideMerge chains one into the next instead.
    const combined = addSinkLayer(b).pipe(Layer.provideMerge(addSinkLayer(a)))

    const program = Effect.gen(function*() {
      return yield* TraceSinks
    })

    const result = Effect.runSync(Effect.provide(program, combined))

    expect(result.size).toBe(2)
    expect(result.has(a)).toBe(true)
    expect(result.has(b)).toBe(true)
  })

  test("TraceSinks can also be read via Context.get on the built context", () => {
    const a: TraceSink = () => {}
    const program = Effect.gen(function*() {
      const context = yield* Layer.build(addSinkLayer(a))
      return Context.get(context, TraceSinks)
    })

    const result = Effect.runSync(Effect.scoped(program))

    expect(result.size).toBe(1)
    expect(result.has(a)).toBe(true)
  })
})
