import { type Effect, JsonSchema, Schema } from "effect"

/**
 * `VerdictSchema<A>`: the only value `--json-schema` accepts.
 *
 * `claude -p --json-schema` accepts JSON Schema draft-07. A document whose `$schema` names another
 * draft exits 1 at startup:
 *
 * ```
 * Error: --json-schema is not a valid JSON Schema:
 *   no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
 * ```
 *
 * `Schema.toJsonSchemaDocument` emits draft-2020-12 and returns `{ dialect, schema, definitions }`,
 * where a named nested struct appears as a `$ref` in `schema` with its target in the sibling
 * `definitions` field. Three steps make that CLI-ready, and this module is where all three happen:
 * conversion to draft-07 (which rewrites every `$ref` from `#/$defs/X` to `#/definitions/X`), the
 * merge of `definitions` into the emitted object, and an explicit draft-07 `$schema`.
 *
 * `decode` and `document` come from the same `Schema` value: the contract shown to the model and
 * the contract enforced on its answer are one definition.
 *
 * **Authoring rule for verdict schemas: use `Schema.Finite`, `Schema.Int` and
 * `Schema.optionalKey`.** `Schema.Number` emits
 * `anyOf: [{type:"number"}, {type:"string", enum:["Infinity","-Infinity","NaN"]}]` — Effect's JSON
 * round-trip fidelity, which reaches the model as part of the contract. `Schema.Finite` emits
 * `{type:"number"}`, `Schema.Int` emits `{type:"integer"}`, and `Schema.optionalKey` emits a
 * plainly-absent key where `Schema.optional` emits a nullable union.
 */

export const DRAFT_07_URI = "http://json-schema.org/draft-07/schema#"

declare const VerdictSchemaId: unique symbol

export interface VerdictSchema<A> {
  readonly [VerdictSchemaId]: "mag/runtime/claude/VerdictSchema"
  readonly decode: (u: unknown) => Effect.Effect<A, Schema.SchemaError>
  readonly document: JsonSchema.Document<"draft-07">
  /** Exactly what `--json-schema` receives. */
  readonly serialized: string
}

/**
 * The sole constructor. The branded property is declared and never assigned at the type level,
 * which leaves this function the only way to obtain a `VerdictSchema` without a cast.
 */
export const verdictSchema = <A>(schema: Schema.Schema<A>): VerdictSchema<A> => {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema))
  const hasDefinitions = Object.keys(document.definitions).length > 0
  const serialized = JSON.stringify({
    $schema: DRAFT_07_URI,
    ...document.schema,
    ...(hasDefinitions ? { definitions: document.definitions } : {})
  })
  return {
    decode: Schema.decodeUnknownEffect(schema),
    document,
    serialized
  } as VerdictSchema<A>
}
