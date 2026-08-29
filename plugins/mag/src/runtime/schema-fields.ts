import { SchemaAST } from "effect"

/**
 * The one place a schema's own fields are read off its AST, so nobody re-derives what "declares
 * fields" means. Two exports because a caller that must judge an index signature needs the AST
 * itself, and one that only lists fields does not.
 *
 * `effect`'s own `AGENTS.md` does not cover AST introspection; the grounding is
 * `effect/src/SchemaAST.ts` (`isObjects`, `Objects`, `PropertySignature`).
 */

/** The object AST that declares a schema's fields, or `undefined` when it declares none: a union, a
 *  primitive, or no schema handle at all. */
export const objectAstOf = (ast: SchemaAST.AST | undefined): SchemaAST.Objects | undefined =>
  ast !== undefined && SchemaAST.isObjects(ast) ? ast : undefined

/** The field names a schema declares, in declaration order. `undefined` — distinct from an empty
 *  list, which is a struct carrying no fields — is a schema whose fields cannot be enumerated at all.
 *  An AST property key is a `PropertyKey`, a field name is a string. */
export const schemaFieldNames = (ast: SchemaAST.AST | undefined): readonly string[] | undefined =>
  objectAstOf(ast)?.propertySignatures.map((signature) => String(signature.name))
