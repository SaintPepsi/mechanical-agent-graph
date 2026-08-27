import { Result } from "effect"
import { InvalidDescription, InvalidNodeName } from "mag/graph-nodes/create/errors"
import { RESERVED_BINDINGS, toCamel } from "mag/graph-nodes/create/template"
import { isControlCode } from "mag/runtime/escape"

/** Lowercase kebab, anchored at both ends. */
const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

// ECMAScript reserved words. The name pattern accepts these verbatim ("delete", "new", "import"
// are all legal kebab names), but toCamel is the identity function on a single, dash-free segment,
// so `export const delete = ...` would be a parse error, not the scaffold's deliberate one.
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "export", "extends", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "return",
  "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "enum", "implements",
  "interface", "let", "package", "private", "protected", "public", "static", "yield", "null", "true", "false", "await"
])

/** Rejects a non-kebab name, then one whose camelCase form collides. */
export const validName = (name: string): Result.Result<string, InvalidNodeName> => {
  if (!NAME_PATTERN.test(name)) {
    return Result.fail(
      new InvalidNodeName({ name, pattern: NAME_PATTERN.source, reason: "name must match the pattern" })
    )
  }

  const identifier = toCamel(name)
  if (RESERVED_WORDS.has(identifier) || RESERVED_BINDINGS.has(identifier)) {
    return Result.fail(
      new InvalidNodeName({
        name,
        pattern: NAME_PATTERN.source,
        reason: `name produces the reserved or colliding identifier "${identifier}"`
      })
    )
  }

  return Result.succeed(name)
}

const isControlCharacter = (character: string): boolean => isControlCode(character.codePointAt(0) ?? 0)

/**
 * Rejects a description that is empty (including whitespace-only), spans multiple
 * lines, or carries any other control character, each case with its own `reason` so a caller
 * can tell them apart. An accepted description is returned verbatim, never
 * trimmed: the `.trim()` below is used only to detect all-whitespace input, never to mutate what's
 * returned.
 */
export const cleanDescription = (description: string): Result.Result<string, InvalidDescription> => {
  if (description.trim().length === 0) {
    return Result.fail(new InvalidDescription({ reason: "description must not be empty or whitespace-only" }))
  }
  if (description.includes("\n") || description.includes("\r")) {
    return Result.fail(new InvalidDescription({ reason: "description must be a single line" }))
  }
  if (Array.from(description).some(isControlCharacter)) {
    return Result.fail(new InvalidDescription({ reason: "description must not contain control characters" }))
  }
  return Result.succeed(description)
}
