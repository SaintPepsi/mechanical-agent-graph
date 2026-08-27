import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { DRAFT_07_URI, verdictSchema } from "mag/runtime/claude/verdict-schema"

/**
 * `--json-schema` accepts draft-07 and rejects draft 2020-12 at startup, keying off the `$schema`
 * value: a 2020-12 document exits 1 with `no schema with key or ref
 * "https://json-schema.org/draft/2020-12/schema"`. Effect v4 emits 2020-12 by default, so the
 * conversion here is what makes an Effect `Schema` usable as a CLI argument at all.
 *
 * These cases pin the serialized document the CLI receives: the dialect, the `definitions` keyword
 * and its `#/definitions/` refs, and the decoder that comes with it.
 */

const Verdict = Schema.Struct({
  status: Schema.Literals(["pass", "fail"]),
  findings: Schema.Array(Schema.String)
})

interface Tree {
  readonly name: string
  readonly children: ReadonlyArray<Tree>
}
const Tree = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree))
})

describe("verdictSchema", () => {
  test("the document declares draft-07", () => {
    expect(verdictSchema(Verdict).document.dialect).toBe("draft-07")
  })

  test("the serialized argument carries the draft-07 $schema URI as its first key", () => {
    const serialized: Record<string, unknown> = JSON.parse(verdictSchema(Verdict).serialized)
    expect(serialized["$schema"]).toBe(DRAFT_07_URI)
    expect(Object.keys(serialized)[0]).toBe("$schema")
  })

  test("the 2020-12 URI appears nowhere in the serialized argument", () => {
    expect(verdictSchema(Verdict).serialized).not.toContain("2020-12")
  })

  test("the struct's own shape survives the conversion", () => {
    const serialized = JSON.parse(verdictSchema(Verdict).serialized)
    expect(serialized.type).toBe("object")
    expect(serialized.required).toEqual(["status", "findings"])
    expect(serialized.properties.status.enum).toEqual(["pass", "fail"])
  })

  test("a recursive schema refs through `#/definitions/`, the draft-07 keyword", () => {
    const serialized = verdictSchema(Tree).serialized
    expect(serialized).toContain("#/definitions/")
    expect(serialized).not.toContain("#/$defs/")
  })

  test("a recursive schema's definitions travel inside the serialized argument, not beside it", () => {
    const serialized: Record<string, unknown> = JSON.parse(verdictSchema(Tree).serialized)
    const definitions = serialized["definitions"] as Record<string, unknown>
    expect(Object.keys(definitions).length).toBeGreaterThan(0)
    const ref = serialized["$ref"] as string
    expect(definitions[ref.replace("#/definitions/", "")]).toBeDefined()
  })

  test("a schema with nothing to define carries no empty definitions key", () => {
    const serialized: Record<string, unknown> = JSON.parse(verdictSchema(Verdict).serialized)
    expect("definitions" in serialized).toBe(false)
  })

  test("the attached decoder accepts a value matching the schema", () => {
    const decoded = Effect.runSync(verdictSchema(Verdict).decode({ status: "pass", findings: [] }))
    expect(decoded).toEqual({ status: "pass", findings: [] })
  })

  test("the attached decoder rejects a value the schema does not describe", () => {
    const result = Effect.runSyncExit(verdictSchema(Verdict).decode({ status: "maybe", findings: [] }))
    expect(result._tag).toBe("Failure")
  })
})

/**
 * `Schema.Number` covers JavaScript's number, which includes `Infinity` and `NaN`, and JSON has no
 * literal for either. Effect encodes them as the strings `"Infinity"`, `"-Infinity"` and `"NaN"`,
 * so the emitted document is an `anyOf` that also accepts a string in that position — a model may
 * answer `"NaN"` where the node's author meant a number. `Schema.Finite` and `Schema.Int` describe
 * one JSON type each.
 *
 * These cases exist to make the difference visible at authoring time.
 */
describe("number field emissions", () => {
  const propertyOf = (schema: Schema.Schema<never> | Schema.Codec<{ readonly n: unknown }>): Record<string, unknown> =>
    JSON.parse(verdictSchema(schema as Schema.Codec<{ readonly n: unknown }>).serialized).properties.n

  test("Schema.Number widens to anyOf number-or-the-three-non-finite-strings", () => {
    const property = propertyOf(Schema.Struct({ n: Schema.Number }))
    expect(property["anyOf"]).toEqual([
      { type: "number" },
      { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }
    ])
  })

  test("Schema.Finite emits a plain number", () => {
    expect(propertyOf(Schema.Struct({ n: Schema.Finite }))).toEqual({ type: "number" })
  })

  test("Schema.Int emits a plain integer", () => {
    expect(propertyOf(Schema.Struct({ n: Schema.Int }))).toEqual({ type: "integer" })
  })
})

/**
 * `Schema.optional` puts a null union in front of the model on an optional reply field;
 * `Schema.optionalKey` does not. Pinned here, generically, rather than left as a claim in a design
 * doc — `build`'s own `dispute` reply field (`graph-node.ts`) is the authoring choice this proves
 * correct.
 */
describe("optional field emissions", () => {
  test("Schema.optional widens an optional string to anyOf string-or-null and keeps it out of required", () => {
    const serialized: Record<string, unknown> = JSON.parse(
      verdictSchema(Schema.Struct({ summary: Schema.String, dispute: Schema.optional(Schema.String) })).serialized
    )
    const properties = serialized["properties"] as Record<string, unknown>
    expect(properties["dispute"]).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })
    expect(serialized["required"]).toEqual(["summary"])
  })

  test("Schema.optionalKey emits a plain string with no null in the contract shown to the model", () => {
    const serialized: Record<string, unknown> = JSON.parse(
      verdictSchema(Schema.Struct({ summary: Schema.String, dispute: Schema.optionalKey(Schema.String) })).serialized
    )
    const properties = serialized["properties"] as Record<string, unknown>
    expect(properties["dispute"]).toEqual({ type: "string" })
    expect(serialized["required"]).toEqual(["summary"])
  })

  test("both decode a reply with the field present or absent, to the same shape", () => {
    const schema = verdictSchema(Schema.Struct({ summary: Schema.String, dispute: Schema.optionalKey(Schema.String) }))
    expect(Effect.runSync(schema.decode({ summary: "s" }))).toEqual({ summary: "s" })
    expect(Effect.runSync(schema.decode({ summary: "s", dispute: "d" }))).toEqual({ summary: "s", dispute: "d" })
  })
})
