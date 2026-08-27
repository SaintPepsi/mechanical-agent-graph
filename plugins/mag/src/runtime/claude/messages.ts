import { Schema } from "effect"

/**
 * The result message's schema, and the two accessors the stream reader uses on every other line.
 *
 * The `result` line is the one message whose contents decide an outcome, so it is the one that
 * earns a decode. Every other line contributes liveness and at most two string fields (`type`,
 * `subtype`), which `lineType` and `lineSubtype` read directly.
 *
 * `ResultMessage` decodes the fields the transport depends on. A real result message carries 22
 * top-level keys against the 11 the docs list, so a schema that insisted on an exact shape would
 * turn each new CLI field into a transport failure on a run that succeeded. Effect's `Struct` drops
 * undeclared keys on decode, which is why `ClaudeReply.result` carries the raw parsed line rather
 * than this decoded value: the decode is the guard, the raw line is the payload.
 */
export const ResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(Schema.NullOr(Schema.String)),
  structured_output: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  session_id: Schema.optionalKey(Schema.String),
  total_cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  api_error_status: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  terminal_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  num_turns: Schema.optionalKey(Schema.Finite),
  duration_ms: Schema.optionalKey(Schema.Finite),
  usage: Schema.optionalKey(Schema.Unknown)
})

export type ResultMessage = Schema.Schema.Type<typeof ResultMessage>

export const decodeResultMessage = Schema.decodeUnknownEffect(ResultMessage)

/** The `type` of a parsed stream line, when it has one. */
export const lineType = (parsed: unknown): string | null =>
  typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string"
    ? (parsed as { type: string }).type
    : null

/** The `subtype` of a parsed stream line, when it has one. */
export const lineSubtype = (parsed: unknown): string | null =>
  typeof parsed === "object" && parsed !== null && typeof (parsed as { subtype?: unknown }).subtype === "string"
    ? (parsed as { subtype: string }).subtype
    : null
