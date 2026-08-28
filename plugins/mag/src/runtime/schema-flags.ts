import { Option, Result, Schema, SchemaAST } from "effect"
import { UnsupportedInputSchema } from "mag/runtime/errors"
import { fieldNameOf, objectAstOf } from "mag/runtime/schema-fields"
import type { CommandNode, FlagKind, FlagSpec } from "mag/runtime/types"

/** camelCase field name -> kebab-case flag name (`maxRetries` -> `max-retries`). */
export const kebabCase = (field: string): string =>
  field
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()

export const resolveExpected = SchemaAST.resolveAt<string>("expected")

/**
 * The wording a node carries about itself. Effect splits this across two annotation keys: an
 * author-supplied `description`, and the `expected` a check writes for its own constraint.
 * `Schema.isInt()` sets `expected: "an integer"`, the same string its predecessor wrote into
 * `description`. Author wording wins; `expected` is the fallback.
 */
const describedBy = (ast: SchemaAST.AST): string | undefined =>
  SchemaAST.resolveDescription(ast) ?? resolveExpected(ast)

/** The default description baseline a bare primitive keyword already carries, read from Effect itself. */
const baselineAstByKind: Record<FlagKind, SchemaAST.AST> = {
  string: SchemaAST.string,
  number: SchemaAST.number,
  boolean: SchemaAST.boolean
}

const baselineDescription = (kind: FlagKind): string => describedBy(baselineAstByKind[kind]) ?? ""

/** A blank or whitespace-only description is no help line at all. */
const toHelp = (description: string): Option.Option<string> => {
  const trimmed = description.trim()
  return trimmed === "" ? Option.none() : Option.some(trimmed)
}

/**
 * `Schema.optional(X)` surfaces in the AST as a union of `X | undefined`. Strip the
 * `Undefined` member to reach the underlying type. Optionality itself is read from the property's
 * own `context.isOptional` via `SchemaAST.isOptional`, never re-derived from this union shape.
 */
const stripOptionalUnion = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (SchemaAST.isUnion(ast)) {
    const withoutUndefined = ast.types.filter((member) => !SchemaAST.isUndefined(member))
    if (withoutUndefined.length === 1) {
      return withoutUndefined[0]
    }
  }
  return ast
}

const flagKindByAstTag: Record<string, FlagKind> = {
  String: "string",
  Number: "number",
  Boolean: "boolean"
}

/**
 * The help line for one field, in precedence order:
 *  1. The property's own description annotation, verbatim (the only site Effect never writes to
 *     itself), read before the optional union is stripped.
 *  2. Otherwise the optionality-stripped field type's own wording, kept only when it differs from
 *     that primitive's own default baseline.
 *  3. A blank or whitespace-only description at either site collapses to `None`.
 */
export const userHelp = (signature: SchemaAST.PropertySignature, kind: FlagKind): Option.Option<string> => {
  const signatureDescription = SchemaAST.resolveDescription(signature.type)
  if (signatureDescription !== undefined) {
    return toHelp(signatureDescription)
  }

  const fieldAst = stripOptionalUnion(signature.type)
  const typeDescription = describedBy(fieldAst)
  if (typeDescription === undefined) {
    return Option.none()
  }

  if (typeDescription === baselineDescription(kind)) {
    return Option.none()
  }

  return toHelp(typeDescription)
}

/**
 * Walk a command node's input schema into its flag IR. Pure AST walk over `effect`'s
 * `Schema`/`SchemaAST` only — this file never imports `@effect/cli`.
 *
 * Refinements need no unwrapping: a check (`Schema.isInt()`, `Schema.isBetween(...)`) hangs off the
 * primitive node it constrains rather than wrapping it, so the field's own `_tag` is already the
 * primitive's, and `spec.schema` keeps the check.
 */
export const deriveFlagSpecs = (node: CommandNode): Result.Result<readonly FlagSpec[], UnsupportedInputSchema> => {
  const rootAst = node.input.ast
  const rootObjects = objectAstOf(rootAst)
  if (rootObjects === undefined) {
    return Result.fail(new UnsupportedInputSchema({ node: node.name, field: "<root>", type: rootAst._tag }))
  }
  if (rootObjects.indexSignatures.length > 0) {
    return Result.fail(new UnsupportedInputSchema({ node: node.name, field: "<root>", type: "IndexSignature" }))
  }

  const specs: Array<FlagSpec> = []
  for (const signature of rootObjects.propertySignatures) {
    const field = fieldNameOf(signature)
    const optional = SchemaAST.isOptional(signature.type)
    const strippedAst = stripOptionalUnion(signature.type)
    const kind = flagKindByAstTag[strippedAst._tag]

    if (kind === undefined) {
      return Result.fail(new UnsupportedInputSchema({ node: node.name, field, type: strippedAst._tag }))
    }

    specs.push({
      field,
      flag: kebabCase(field),
      kind,
      optional,
      help: userHelp(signature, kind),
      schema: Schema.make<Schema.Codec<unknown>>(strippedAst)
    })
  }

  return Result.succeed(specs)
}
