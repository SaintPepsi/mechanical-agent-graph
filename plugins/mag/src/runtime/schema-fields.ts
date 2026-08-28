import { SchemaAST } from "effect"

/**
 * The one place a schema's own fields are read off its AST. Three callers need a different slice of
 * that one fact — `schema-flags.ts` needs every property signature (its type, its optionality, its
 * wording) and the index signatures beside them, `construct.ts`'s shape walk needs the field names,
 * `graph-node.shape.ts` needs only whether there are any — so the narrowing and the name mapping are
 * separate exports and nobody re-derives what "declares fields" means.
 *
 * `effect`'s own `AGENTS.md` does not cover AST introspection; the grounding is
 * `effect/src/SchemaAST.ts` (`isObjects`, `Objects`, `PropertySignature`).
 */

/** The object AST that declares a schema's fields, or `undefined` when it declares none: a union, a
 *  primitive, or no schema handle at all. */
export const objectAstOf = (ast: SchemaAST.AST | undefined): SchemaAST.Objects | undefined =>
  ast !== undefined && SchemaAST.isObjects(ast) ? ast : undefined

/** A property signature's field name: an AST property key is a `PropertyKey`, a field name is a string. */
export const fieldNameOf = (signature: SchemaAST.PropertySignature): string => String(signature.name)

/** The field names a schema declares, in declaration order. `undefined` — distinct from an empty
 *  list, which is a struct carrying no fields — is a schema whose fields cannot be enumerated at all. */
export const schemaFieldNames = (ast: SchemaAST.AST | undefined): readonly string[] | undefined =>
  objectAstOf(ast)?.propertySignatures.map(fieldNameOf)
