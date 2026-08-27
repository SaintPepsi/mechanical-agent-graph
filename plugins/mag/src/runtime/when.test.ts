import { describe, expect, test } from "bun:test"
import { Data, Effect, Option, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { when } from "mag/runtime/when"

/** A probe whose verdict the test drives through its own input, rather than shared mutable state. */
const probe = make({
  name: "fixture-probe",
  description: "Returns whatever verdict the test passes in.",
  input: Schema.Struct({ matched: Schema.Boolean }),
  success: Schema.Struct({ matched: Schema.Boolean }),
  run: (input) => Effect.succeed({ matched: input.matched })
})

class ProbeFailed extends Data.TaggedError("PROBE_FAILED")<{ readonly detail: string }> {}

const failingProbe = make({
  name: "fixture-failing-probe",
  description: "Always fails, so `when` has an error to propagate.",
  input: Schema.Struct({}),
  success: Schema.Struct({ matched: Schema.Boolean }),
  run: () => Effect.fail(new ProbeFailed({ detail: "probe blew up" }))
})

/** Counts entries so a skip is observed rather than inferred. */
const countingGuarded = () => {
  let entries = 0
  const node = make({
    name: "fixture-guarded",
    description: "Increments a counter every time it actually runs.",
    input: Schema.Struct({}),
    success: Schema.Struct({ ran: Schema.Boolean }),
    run: () => Effect.sync(() => { entries += 1; return { ran: true } })
  })
  return { node, entries: () => entries }
}

describe("when", () => {
  test("matched: true runs the guarded node and yields Option.some", async () => {
    const { node, entries } = countingGuarded()
    const result = await Effect.runPromise(
      when(probe, node)({ probe: { matched: true }, node: {} })
    )
    expect(Option.isSome(result)).toBe(true)
    expect(entries()).toBe(1)
  })

  test("matched: false yields Option.none and never enters the guarded node", async () => {
    const { node, entries } = countingGuarded()
    const result = await Effect.runPromise(
      when(probe, node)({ probe: { matched: false }, node: {} })
    )
    expect(Option.isNone(result)).toBe(true)
    expect(entries()).toBe(0)
  })

  test("a failing probe propagates its tag and the guarded node is never entered", async () => {
    const { node, entries } = countingGuarded()
    const failure = await Effect.runPromise(
      Effect.flip(when(failingProbe, node)({ probe: {}, node: {} }))
    )
    expect(failure).toBeInstanceOf(ProbeFailed)
    expect(entries()).toBe(0)
  })
})
