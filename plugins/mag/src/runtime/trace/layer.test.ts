import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { RunId, tracingLayer } from "mag/runtime/trace/layer"

describe("tracingLayer", () => {
  test("one sortable run id, exposed to everything downstream of main", () => {
    const ids = Effect.runSync(
      Effect.gen(function* () {
        return [yield* RunId, yield* RunId]
      }).pipe(Effect.provide(tracingLayer))
    )

    // Both reads see the one minted id — `Layer.provideMerge` keeps it in the layer's output, so
    // the journal wiring reads the same value the tracer froze, not a fresh default.
    expect(ids[0]).toBe(ids[1])
    // UTC second-stamp + entropy: lexicographic order over run directories is start order.
    expect(ids[0]).toMatch(/^\d{14}-[0-9a-f]{4}$/)
  })
})
