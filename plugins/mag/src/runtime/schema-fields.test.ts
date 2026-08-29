import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { objectAstOf, schemaFieldNames } from "mag/runtime/schema-fields"

describe("schemaFieldNames", () => {
  test("a struct's field names come back in declaration order", () => {
    expect(schemaFieldNames(Schema.Struct({ second: Schema.String, first: Schema.Number }).ast)).toEqual([
      "second",
      "first"
    ])
  })

  test("an empty struct declares an empty list, never nothing: it is an object that carries no fields", () => {
    expect(schemaFieldNames(Schema.Struct({}).ast)).toEqual([])
  })

  test("a schema that is not an object at all declares nothing, and so does no schema at all", () => {
    expect(schemaFieldNames(Schema.String.ast)).toBeUndefined()
    expect(
      schemaFieldNames(Schema.Union([Schema.Struct({ x: Schema.String }), Schema.Struct({ y: Schema.String })]).ast)
    ).toBeUndefined()
    expect(schemaFieldNames(undefined)).toBeUndefined()
  })

  test("objectAstOf hands back the narrowed AST, so a caller can read its property and index signatures directly", () => {
    const objects = objectAstOf(Schema.Struct({ x: Schema.String }).ast)

    expect(objects?.indexSignatures).toEqual([])
    expect(objects?.propertySignatures.map((signature) => String(signature.name))).toEqual(["x"])
  })

  test("an index signature is not a property signature: objectAstOf exposes it on its own list", () => {
    const objects = objectAstOf(Schema.Record(Schema.String, Schema.String).ast)

    expect(objects?.propertySignatures).toEqual([])
    expect(objects?.indexSignatures.length).toBe(1)
  })
})
