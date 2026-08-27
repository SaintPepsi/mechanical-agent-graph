import { Effect, Option, Schema } from "effect"

/**
 * Best-effort schema codecs: `Some` of the value, `None` on any codec failure, never a failure of
 * the returned effect. A value a schema cannot render leaves its caller running rather than ending
 * the run — the posture both the trace boundary (a span whose input would not encode still opens)
 * and the journal (a node whose input would not encode still runs, unreplayable) need.
 *
 * The cast lives here, once, rather than at each call site. A `GraphNode`'s `input`/`success` are
 * the erased `Schema.Schema<T>` view, whose Encoding/Decoding services are `unknown` rather than
 * `never`; left alone that `unknown` reaches the caller's requirement channel, which is what would
 * stop `journaled` from returning a `GraphNode<I, A, E, R>`. Narrowing it back is the same erasure
 * boundary `run-cli.ts` draws around its own `AnyCommand` cast — a structurally-guaranteed type pinned back into
 * place, with no information discarded.
 *
 * This module imports `effect` and nothing else. `journaled` is applied inside `make`
 * (`graph-node.definition.ts`), so whatever it reaches, every node reaches.
 */
const bestEffort = <T>(codec: Effect.Effect<T, unknown, unknown>): Effect.Effect<Option.Option<T>> =>
  Effect.matchCause(codec, {
    onSuccess: Option.some,
    // `matchCause`, not `Effect.option`: `option` folds typed failures only, so a codec that DIES
    // (a user transformation that throws) would escape the best-effort promise as a defect.
    onFailure: () => Option.none<T>()
  }) as Effect.Effect<Option.Option<T>>

/** Encode `value` against `schema`. `None` when the schema cannot render it. */
export const encodeBestEffort = <T>(schema: Schema.Schema<T>, value: T): Effect.Effect<Option.Option<unknown>> =>
  bestEffort<unknown>(Schema.encodeEffect(schema)(value))

/** Decode `value` against `schema`. `None` when the value is the wrong shape for it now. */
export const decodeBestEffort = <T>(schema: Schema.Schema<T>, value: unknown): Effect.Effect<Option.Option<T>> =>
  bestEffort<T>(Schema.decodeUnknownEffect(schema)(value))
