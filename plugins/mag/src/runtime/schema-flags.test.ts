import { describe, expect, test } from "bun:test"
import { Option, Result, Schema, SchemaAST } from "effect"
import { deriveFlagSpecs, kebabCase, resolveExpected, userHelp } from "mag/runtime/schema-flags"
import type { FlagSpec } from "mag/runtime/types"
import { fixtureNode } from "mag/test/fixtures/command-node"

// ---------------------------------------------------------------------------
// kebabCase
// ---------------------------------------------------------------------------

describe("kebabCase", () => {
  test("camelCase field becomes a kebab flag", () => {
    expect(kebabCase("maxRetries")).toBe("max-retries")
  })

  test("single-word field is unchanged", () => {
    expect(kebabCase("name")).toBe("name")
  })

  test("consecutive capitals stay readable", () => {
    expect(kebabCase("dryRunID")).toBe("dry-run-id")
  })
})

// ---------------------------------------------------------------------------
// userHelp
// ---------------------------------------------------------------------------

/** Read the first property signature of a one-field struct, the real call shape userHelp sees. */
const firstSignature = (fields: Schema.Struct.Fields): SchemaAST.PropertySignature => {
  const ast = Schema.Struct(fields).ast
  if (!SchemaAST.isObjects(ast)) throw new Error("Schema.Struct did not produce an Objects AST")
  return ast.propertySignatures[0]
}

describe("userHelp", () => {
  test("bare Schema.String carries no user-supplied help", () => {
    const signature = firstSignature({ field: Schema.String })

    expect(userHelp(signature, "string")).toEqual(Option.none())
  })

  test("an annotated Schema.String surfaces its own description verbatim", () => {
    const signature = firstSignature({ field: Schema.String.annotate({ description: "The node name" }) })

    expect(userHelp(signature, "string")).toEqual(Option.some("The node name"))
  })

  test("a refined-but-unannotated field surfaces Effect's own refinement wording", () => {
    const fieldSchema = Schema.Number.check(Schema.isInt())
    const signature = firstSignature({ field: fieldSchema })

    // Read the expectation off the schema itself — never a hardcoded "an integer". A check writes
    // its own wording under `expected`, the key userHelp falls back to when no description is set.
    const expected = resolveExpected(fieldSchema.ast)
    expect(expected !== undefined && expected.trim() !== "").toBe(true)
    expect(userHelp(signature, "number")).toEqual(Option.fromNullishOr(expected))
  })

  test("a property-signature annotation overrides a refinement's wording", () => {
    const signature = firstSignature({
      field: Schema.Number.check(Schema.isInt()).annotate({ description: "How many retries" })
    })

    expect(userHelp(signature, "number")).toEqual(Option.some("How many retries"))
  })

  test("an optional field's property-signature annotation wins (site 1)", () => {
    const signature = firstSignature({
      field: Schema.optional(Schema.String).annotate({ description: "Optional note" })
    })

    expect(userHelp(signature, "string")).toEqual(Option.some("Optional note"))
  })

  test("a blank description at the property-signature site collapses to None", () => {
    const signature = firstSignature({
      field: Schema.String.annotate({ description: "  " })
    })

    expect(userHelp(signature, "string")).toEqual(Option.none())
  })

  test("Schema.between reports its own bounds-interpolated wording, read from the schema", () => {
    const fieldSchema = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 }))
    const signature = firstSignature({ field: fieldSchema })

    const expected = resolveExpected(fieldSchema.ast)
    expect(expected !== undefined && expected.trim() !== "").toBe(true)
    expect(userHelp(signature, "number")).toEqual(Option.fromNullishOr(expected))
  })
})

// ---------------------------------------------------------------------------
// deriveFlagSpecs
// ---------------------------------------------------------------------------

const specFor = (specs: readonly FlagSpec[], field: string): FlagSpec => {
  const spec = specs.find((s) => s.field === field)
  if (spec === undefined) {
    throw new Error(`no spec produced for field ${field}`)
  }
  return spec
}

describe("deriveFlagSpecs — accepting cases", () => {
  test("a flat struct of string/number/boolean produces three required specs", () => {
    const node = fixtureNode(
      "flat",
      Schema.Struct({ name: Schema.String, count: Schema.Number, active: Schema.Boolean })
    )

    const result = deriveFlagSpecs(node)
    expect(Result.isSuccess(result)).toBe(true)
    const specs = Result.getOrThrow(result)

    expect(specFor(specs, "name")).toMatchObject({ field: "name", flag: "name", kind: "string", optional: false })
    expect(specFor(specs, "count")).toMatchObject({ field: "count", flag: "count", kind: "number", optional: false })
    expect(specFor(specs, "active")).toMatchObject({
      field: "active",
      flag: "active",
      kind: "boolean",
      optional: false
    })
  })

  test("Schema.optional(Schema.String) is optional, kind string, and the schema decodes a plain string", () => {
    const node = fixtureNode("optString", Schema.Struct({ note: Schema.optional(Schema.String) }))

    const specs = Result.getOrThrow(deriveFlagSpecs(node))
    const spec = specFor(specs, "note")

    expect(spec.optional).toBe(true)
    expect(spec.kind).toBe("string")
    expect(Schema.decodeUnknownSync(spec.schema)("hello")).toBe("hello")
  })

  test("Schema.optional(Schema.Boolean) is optional, kind boolean", () => {
    const node = fixtureNode("optBool", Schema.Struct({ verbose: Schema.optional(Schema.Boolean) }))

    const specs = Result.getOrThrow(deriveFlagSpecs(node))
    const spec = specFor(specs, "verbose")

    expect(spec.optional).toBe(true)
    expect(spec.kind).toBe("boolean")
  })

  test("a refined field keeps kind number and the refinement survives into spec.schema", () => {
    const node = fixtureNode("refined", Schema.Struct({ maxRetries: Schema.Number.check(Schema.isInt()) }))

    const specs = Result.getOrThrow(deriveFlagSpecs(node))
    const spec = specFor(specs, "maxRetries")

    expect(spec.kind).toBe("number")
    expect(Result.isSuccess(Schema.decodeUnknownResult(spec.schema)(2))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(spec.schema)(1.5))).toBe(true)
  })

  test("help precedence flows through: annotated is Some, bare is None, refined-unannotated is Some", () => {
    const fieldSchema = Schema.Number.check(Schema.isInt())
    const node = fixtureNode(
      "help",
      Schema.Struct({
        annotated: Schema.String.annotate({ description: "The node name" }),
        bare: Schema.String,
        refined: fieldSchema
      })
    )

    const specs = Result.getOrThrow(deriveFlagSpecs(node))

    expect(specFor(specs, "annotated").help).toEqual(Option.some("The node name"))
    expect(specFor(specs, "bare").help).toEqual(Option.none())

    const expectedRefinedHelp = resolveExpected(fieldSchema.ast)
    expect(expectedRefinedHelp !== undefined && expectedRefinedHelp.trim() !== "").toBe(true)
    expect(specFor(specs, "refined").help).toEqual(Option.fromNullishOr(expectedRefinedHelp))
  })

  test("field ordering in the output matches propertySignatures order", () => {
    const node = fixtureNode(
      "ordered",
      Schema.Struct({ zeta: Schema.String, alpha: Schema.String, mid: Schema.String })
    )

    const specs = Result.getOrThrow(deriveFlagSpecs(node))

    expect(specs.map((s) => s.field)).toEqual(["zeta", "alpha", "mid"])
  })
})

describe("deriveFlagSpecs — rejecting cases", () => {
  test("a nested Schema.Struct field is unsupported and names the node/field/type", () => {
    const node = fixtureNode("nested", Schema.Struct({ inner: Schema.Struct({ x: Schema.String }) }))

    const result = deriveFlagSpecs(node)
    expect(Result.isFailure(result)).toBe(true)
    const error = Result.getOrThrow(Result.flip(result))

    expect(error.node).toBe("nested")
    expect(error.field).toBe("inner")
    expect(error.type).toBe("Objects")
  })

  test("a Schema.Union field is unsupported and names the node/field/type", () => {
    const node = fixtureNode("union", Schema.Struct({ choice: Schema.Union([Schema.String, Schema.Number]) }))

    const error = Result.getOrThrow(Result.flip(deriveFlagSpecs(node)))

    expect(error.node).toBe("union")
    expect(error.field).toBe("choice")
    expect(error.type).toBe("Union")
  })

  test("a Schema.Array field is unsupported and names the node/field/type", () => {
    const node = fixtureNode("array", Schema.Struct({ items: Schema.Array(Schema.String) }))

    const error = Result.getOrThrow(Result.flip(deriveFlagSpecs(node)))

    expect(error.node).toBe("array")
    expect(error.field).toBe("items")
    expect(error.type).toBe("Arrays")
  })

  test("a Schema.Literal field is unsupported and names the node/field/type", () => {
    const node = fixtureNode("literal", Schema.Struct({ mode: Schema.Literal("fixed") }))

    const error = Result.getOrThrow(Result.flip(deriveFlagSpecs(node)))

    expect(error.node).toBe("literal")
    expect(error.field).toBe("mode")
    expect(error.type).toBe("Literal")
  })

  test("a non-struct root input rejects with field '<root>' and the root AST's own tag", () => {
    const node = fixtureNode("root-string", Schema.String)

    const error = Result.getOrThrow(Result.flip(deriveFlagSpecs(node)))

    expect(error.node).toBe("root-string")
    expect(error.field).toBe("<root>")
    expect(error.type).toBe("String")
  })

  test("a struct with an index signature is unsupported, not silently accepted with a partial surface", () => {
    const node = fixtureNode(
      "mixed-record",
      Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [Schema.Record(Schema.String, Schema.String)])
    )

    const error = Result.getOrThrow(Result.flip(deriveFlagSpecs(node)))

    expect(error.node).toBe("mixed-record")
    expect(error.field).toBe("<root>")
    expect(error.type).toBe("IndexSignature")
  })

  test("a bare Schema.Record root is unsupported, not silently accepted with zero flags", () => {
    const node = fixtureNode("record-root", Schema.Record(Schema.String, Schema.String))

    const error = Result.getOrThrow(Result.flip(deriveFlagSpecs(node)))

    expect(error.node).toBe("record-root")
    expect(error.field).toBe("<root>")
    expect(error.type).toBe("IndexSignature")
  })

  test("when several fields are unsupported, the first offending field wins (no aggregation)", () => {
    const node = fixtureNode(
      "multi-bad",
      Schema.Struct({
        good: Schema.String,
        firstBad: Schema.Array(Schema.String),
        secondBad: Schema.Struct({ x: Schema.String })
      })
    )

    const error = Result.getOrThrow(Result.flip(deriveFlagSpecs(node)))

    expect(error.field).toBe("firstBad")
    expect(error.type).toBe("Arrays")
  })
})
