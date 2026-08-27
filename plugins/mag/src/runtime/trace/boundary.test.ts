import { describe, expect, test } from "bun:test"
import { Cause, Data, Effect, Option, Schema, SchemaGetter, Tracer } from "effect"
import { execute, make } from "mag/runtime/graph-node.definition"
import { nodeRunOf, SUCCESS_ATTRIBUTE, tracedRun } from "./boundary"

/**
 * Decodes any string to its `Number(...)` form and encodes back with `String(...)` — decoded and
 * (re-)encoded values are deliberately different JS types (number vs string), so a test asserting
 * "the marker carries the encoded value, not the decoded one" can't pass by accident because the
 * two happen to look alike.
 */
const NumberFromString = Schema.String.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((s: string) => Number(s)),
    encode: SchemaGetter.transform((n: number) => String(n)),
  })
)

/** Decodes to its input unchanged, but can never be encoded. */
const UnencodableString = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => s),
    encode: SchemaGetter.forbidden(() => "encoding is deliberately forbidden by this fixture"),
  })
)

/** A node whose `run` always succeeds, doubling its decoded number and reporting the double as a string. */
const doubles = make({
  name: "doubles",
  description: "Doubles the decoded number, success value re-encoded as a string.",
  input: NumberFromString,
  success: NumberFromString,
  run: (n: number) => Effect.succeed(n * 2),
})

/** A node whose `run` always fails with a tagged error. */
class Boom extends Data.TaggedError("BOOM")<{}> {}

const failer = make({
  name: "failer",
  description: "Always fails with a tagged error.",
  input: NumberFromString,
  success: NumberFromString,
  run: () => Effect.fail(new Boom()),
})

/** A node whose `run` always throws a raw, untyped defect. */
const defector = make({
  name: "defector",
  description: "Always throws a raw error, never a typed failure.",
  input: NumberFromString,
  success: NumberFromString,
  run: () =>
    Effect.sync(() => {
      throw new Error("unexpected raw throw")
    }),
})

/** A node whose input can never be encoded back. */
const unencodableInput = make({
  name: "unencodable-input",
  description: "Decodes fine, but its input schema can never re-encode the decoded value.",
  input: UnencodableString,
  success: Schema.Struct({ ok: Schema.Boolean }),
  run: () => Effect.succeed({ ok: true }),
})

/** A stub `Tracer` that records every `span(...)` call and otherwise behaves like the real native tracer. */
const stubTracer = (): { readonly tracer: Tracer.Tracer; readonly captured: Array<Tracer.Span> } => {
  const captured: Array<Tracer.Span> = []
  const tracer: Tracer.Tracer = {
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      captured.push(span)
      return span
    },
  }
  return { tracer, captured }
}

/**
 * Runs `effect` under a fresh stub tracer, returning both the spans it captured and the run's
 * `Exit`. `execute`/`tracedRun`'s inferred `R` is `unknown` here only because `GraphNode.input`/
 * `.success` are the erased `Schema.Schema<T>` view (`EncodingServices`/`DecodingServices` are
 * structurally `unknown`, not `never`) — the same erasure `run-cli.ts` names and casts past at its
 * own boundary ("the one deliberate type-erasure boundary in `src/runtime/`"). Every fixture below
 * declares `run: (...) => Effect.Effect<_, _, never>`, so providing `Tracer` really does leave
 * nothing outstanding at runtime; this cast reasserts that structural truth past the erasure, the
 * same way `run-cli.ts`'s own `as Command.Command<...>` does — a precise, concrete-type assertion,
 * not `as any`/`as unknown as`.
 */
const runTraced = async <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const { captured, tracer } = stubTracer()
  const provided = Effect.provideService(effect, Tracer.Tracer, tracer) as Effect.Effect<A, E, never>
  const exit = await Effect.runPromiseExit(provided)
  return { captured, exit }
}

describe("tracedRun / execute — span marker", () => {
  test("a valid run opens exactly one span, named after the node, marked as a node run", async () => {
    const { captured, exit } = await runTraced(execute(doubles, "21"))

    expect(exit._tag).toBe("Success")
    expect(captured.length).toBe(1)
    const span = captured[0]
    if (span === undefined) {
      throw new Error("expected a captured span")
    }
    expect(span.name).toBe("doubles")
    expect(Option.isSome(nodeRunOf(span.annotations))).toBe(true)
  })

  test("the marker carries the encoded input, not the decoded value", async () => {
    const { captured } = await runTraced(execute(doubles, "21"))

    const span = captured[0]
    if (span === undefined) {
      throw new Error("expected a captured span")
    }
    const marker = nodeRunOf(span.annotations)
    // Decoded input is the number 21; the marker must carry its re-encoded form, the string "21".
    expect(marker).toEqual(Option.some({ input: Option.some("21") }))
  })
})

describe("execute — decode failure never opens a span", () => {
  test("input that fails the node's schema calls span zero times and fails the same way decode alone does", async () => {
    // NumberFromString's decode getter runs unconditionally (Number(s) never itself throws), so the
    // schema only fails when `execute`'s own decodeUnknownEffect rejects the *shape* of the input —
    // a number is not a string, so this never even reaches the decode getter.
    const badInput = 42

    // Decoding through `NumberFromString` directly (not `doubles.input`) keeps this comparison's own
    // R concrete: `doubles.input` is the erased `Schema.Schema<number>` view (see `runTraced`'s doc
    // comment), which would otherwise force the same cast just to run this baseline.
    const bareDecodeExit = await Effect.runPromiseExit(Schema.decodeUnknownEffect(NumberFromString)(badInput))
    const { captured, exit } = await runTraced(execute(doubles, badInput))

    expect(captured.length).toBe(0)
    expect(exit).toEqual(bareDecodeExit)
    expect(exit._tag).toBe("Failure")
  })
})

describe("tracedRun — unencodable input still runs and succeeds", () => {
  test("marker input is None, and the node still runs and succeeds", async () => {
    const { captured, exit } = await runTraced(execute(unencodableInput, "hello"))

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toEqual({ ok: true })
    }
    expect(captured.length).toBe(1)
    const span = captured[0]
    if (span === undefined) {
      throw new Error("expected a captured span")
    }
    const marker = nodeRunOf(span.annotations)
    expect(marker).toEqual(Option.some({ input: Option.none() }))
  })
})

describe("tracedRun — success attribute", () => {
  test("a successful run annotates the encoded success value onto its span", async () => {
    const { captured, exit } = await runTraced(execute(doubles, "21"))

    expect(exit._tag).toBe("Success")
    // run(21) succeeds with 42 (a number); the span attribute must carry its re-encoded form, "42".
    expect(captured[0]?.attributes.get(SUCCESS_ATTRIBUTE)).toBe("42")
  })

  test("a failing run's span carries no success attribute", async () => {
    const { captured } = await runTraced(execute(failer, "21"))

    expect(captured.length).toBe(1)
    expect(captured[0]?.attributes.has(SUCCESS_ATTRIBUTE)).toBe(false)
  })
})

describe("tracedRun — the node's own outcome passes through unchanged", () => {
  // `Effect.withSpan` itself annotates a failing/dying Cause with a captured-stack-trace entry
  // (a general span side effect, not something this test cares about), so a whole-Exit comparison would fail
  // on that annotation alone even though nothing about the failure/defect changed. `Cause.squash`
  // strips annotations and unifies fail/die to the one payload value, which is the thing this test
  // actually asserts stays unchanged.
  test("success value is identical with and without the span wrapper", async () => {
    const bare = await Effect.runPromiseExit(doubles.run(21))
    const { exit: traced } = await runTraced(tracedRun(doubles, 21))

    expect(traced).toEqual(bare)
  })

  test("a typed failure is identical with and without the span wrapper", async () => {
    const bare = await Effect.runPromiseExit(failer.run(21))
    const { exit: traced } = await runTraced(tracedRun(failer, 21))

    expect(traced._tag).toBe("Failure")
    expect(bare._tag).toBe("Failure")
    if (traced._tag === "Failure" && bare._tag === "Failure") {
      expect(Cause.squash(traced.cause)).toEqual(Cause.squash(bare.cause))
    }
  })

  test("a raw defect is identical with and without the span wrapper", async () => {
    const bare = await Effect.runPromiseExit(defector.run(21))
    const { exit: traced } = await runTraced(tracedRun(defector, 21))

    expect(traced._tag).toBe("Failure")
    expect(bare._tag).toBe("Failure")
    if (traced._tag === "Failure" && bare._tag === "Failure") {
      expect(Cause.squash(traced.cause)).toEqual(Cause.squash(bare.cause))
    }
  })
})
