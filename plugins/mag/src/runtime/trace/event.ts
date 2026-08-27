import { Schema } from "effect"

/**
 * The four values a close event's `outcome` field can carry —
 * a closed set, not a free-form string, so a sink can switch on it exhaustively.
 */
export const OUTCOMES = ["ok", "fail", "die", "interrupt"] as const

export type Outcome = (typeof OUTCOMES)[number]

/** Schema for {@link Outcome}. */
export const OutcomeSchema = Schema.Literals(OUTCOMES)

/**
 * The span-open event — everything a sink needs to establish a
 * span before anything about how it ends is known. `parentSpanId` is `null`
 * for a root span (never omitted), so a sink can tell "no parent" apart from
 * "field forgotten."
 *
 * Contract, for anyone building on this: `parentSpanId` names the enclosing
 * SPAN, not the enclosing NODE RUN. An unmarked span between two node runs —
 * an `Effect.fn` span, this repo's house style (see
 * `src/graph-nodes/conformance/gather.ts`) — emits no event of its own, so the
 * inner node run's open event points at a span no sink ever sees, and
 * `foldTrace` then reports that inner run as a root rather than as a child.
 * Reconstructing node-run-to-node-run nesting across unmarked spans would need
 * the tracer to walk the parent chain, which it deliberately does not do.
 *
 * `startTimeNanos` is a decimal STRING, not a `bigint`: `JSON.stringify`
 * throws on a `bigint`, and a file sink that throws is a sink that violates
 * its own contract for a reason that has nothing to do with sinks.
 */
export const OpenEventSchema = Schema.Struct({
  kind: Schema.tag("open"),
  runId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.NullOr(Schema.String),
  name: Schema.String,
  startTimeNanos: Schema.String,
  input: Schema.optional(Schema.Unknown)
})

export type OpenEvent = typeof OpenEventSchema.Type

/**
 * The span-close event. Carries the same span identifier
 * as its open event, plus `name`, `durationNanos`, and the
 * `outcome`/`tag` pair: one outcome value always, and a `tag`
 * only when the outcome is `fail` or `die` and the failure/defect carried one
 * — see `outcome.ts`'s `outcomeOf`.
 *
 * `endTimeNanos`/`durationNanos` are decimal STRINGS, not `bigint`s — same
 * reason as `OpenEvent.startTimeNanos`: `JSON.stringify` throws on a
 * `bigint`, and a file sink that throws is a sink that violates
 * its own contract for a reason that has nothing to do with sinks.
 */
export const CloseEventSchema = Schema.Struct({
  kind: Schema.tag("close"),
  runId: Schema.String,
  spanId: Schema.String,
  name: Schema.String,
  endTimeNanos: Schema.String,
  durationNanos: Schema.String,
  outcome: OutcomeSchema,
  tag: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown)
})

export type CloseEvent = typeof CloseEventSchema.Type

/** The tagged union every trace sink decodes/encodes, discriminated on `kind`. */
export const TraceEventSchema = Schema.Union([OpenEventSchema, CloseEventSchema]).pipe(Schema.toTaggedUnion("kind"))

export type TraceEvent = typeof TraceEventSchema.Type
