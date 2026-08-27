import { Effect, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"

/**
 * Round-trips its own decoded input as its success value, so a subprocess test can assert on
 * exactly what was decoded (including which optional keys are absent). Its fields exist to prove
 * every integration case in one node:
 *  - `name`: required string, annotated at the FIELD-TYPE site.
 *  - `count`: required number.
 *  - `verbose`: required boolean (presence-flag semantics).
 *  - `nickname`: bare, unannotated optional string (an absent key stays absent).
 *  - `rawField`: bare, unannotated required string (no help line at all).
 *  - `label`: optional string annotated at the PROPERTY-SIGNATURE site (the other annotation site).
 *  - `maxRetries`: refined (`Schema.Int`), deliberately left unannotated — the
 *    shape that would leak Effect's own "an integer" help line if
 *    `userHelp` ever regressed to comparing only against the bare `Schema.Number` baseline.
 *  - `strict`: bare, unannotated optional boolean — the presence-and-optionality intersection's own
 *    case (`wrapOptionalByKind.boolean` in node-command.ts), exercised end to end: absent stays
 *    absent, bare presence decodes to `true`, and an explicit `--strict=false`/`--no-strict`
 *    decodes to `false` rather than collapsing into the same absence.
 */
const EchoFields = Schema.Struct({
  name: Schema.String.annotate({ description: "The name to echo back." }),
  count: Schema.Number,
  verbose: Schema.Boolean,
  nickname: Schema.optional(Schema.String),
  rawField: Schema.String,
  label: Schema.optional(Schema.String).annotate({ description: "A free-form label for this echo." }),
  maxRetries: Schema.Int,
  strict: Schema.optional(Schema.Boolean),
})

export const echo = make({
  name: "echo",
  description: "Echo back the decoded input, unchanged.",
  input: EchoFields,
  success: EchoFields,
  run: (input) => Effect.succeed(input),
})
