import { escapeQuoted } from "mag/runtime/escape"
import { EXAMPLE_EXPORTS, EXAMPLE_SCHEMA_FIELDS, REQUIRED_FILES, UNIMPLEMENTED_MARKER } from "mag/runtime/graph-node.shape"

/** kebab-case -> camelCase, for the exported node object's identifier. */
const capitalize = (segment: string): string => segment.charAt(0).toUpperCase() + segment.slice(1)

/**
 * Exported (not just template-private) because `validation.ts` is a second consumer: it must
 * reject a name whose camelCase form collides with something the templates below bind, before
 * anything is written.
 */
export const toCamel = (name: string): string =>
  name
    .split("-")
    .map((segment, index) => (index === 0 ? segment : capitalize(segment)))
    .join("")

/** kebab-case -> SCREAMING_SNAKE_CASE, for the emitted tagged error's tag. */
const toScreamingSnake = (name: string): string => name.replace(/-/g, "_").toUpperCase()

/**
 * The node's own contract, with the name and escaped description wired in,
 * valid-but-empty schemas, and a `run` annotated `(): never` whose whole body is a string literal
 * opening with `UNIMPLEMENTED_MARKER`. One construct does three jobs at once: the annotation makes
 * `bun run typecheck` fail inside this function and only here — exactly one compiler error, with
 * the `make(...)` call site itself staying clean; the compiler's own error
 * quotes the literal back, so its message names the node and says it is unimplemented; and the
 * literal opens a string literal in this file's source, which is exactly what
 * `carriesUnimplementedMarker` (graph-node.shape.ts) scans for.
 */
const graphNodeSource = (name: string, description: string, camel: string): string => `import { Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"

// Replace this run with the node's real behaviour. Deleting the ": never" annotation
// and the marker string below is what turns this scaffold into a real, implemented node.
export const ${camel} = make({
  name: "${name}",
  description: ${escapeQuoted(description)},
  input: Schema.Struct({}),
  success: Schema.Struct({}),
  run: (): never => "${UNIMPLEMENTED_MARKER}: ${name} is unimplemented"
})
`

/** At least one tagged error class, string fields only. */
const errorsSource = (name: string, camel: string): string => `import { Data } from "effect"

export class ${capitalize(camel)}Failed extends Data.TaggedError("${toScreamingSnake(name)}_FAILED")<{
  readonly detail: string
}> {}
`

/** One fixture per EXAMPLE_EXPORTS name, read from the shared constant, never typed out. */
const examplesSource = (): string =>
  `${EXAMPLE_EXPORTS.map((exportName) => `export const ${exportName} = [{}]`).join("\n")}\n`

/**
 * Decodes every `EXAMPLE_EXPORTS` fixture array against the schema field
 * `EXAMPLE_SCHEMA_FIELDS` pairs it with — read from the shared constant so the pairing can never be
 * hand-typed out of step with `examples-decode` (rules.ts). Plus one deliberately failing assertion
 * naming the node as unimplemented, so `bun test` is red for the same reason the typecheck is.
 *
 * `${camel}.input`/`.success` are the erased `Schema.Schema<T>` view — `make`'s `GraphNode<I, A, E, R>`
 * return type widens to it, the same erasure `graph-node.shape.ts`'s own `examples-decode` rule hits
 * decoding a loaded node's fixtures generically. `isSchemaHandle` is that rule's fix, reused here
 * rather than a second, unnamed cast: a real `Schema.isSchema` check narrowed to `Schema.Codec<unknown>`,
 * which is what `decodeUnknownSync` needs.
 */
const testSource = (name: string, camel: string): string => {
  const fixtureImports = EXAMPLE_EXPORTS.join(", ")
  const decodeLines = EXAMPLE_EXPORTS.map((exportName) => {
    const field = EXAMPLE_SCHEMA_FIELDS[exportName]
    return `    if (!isSchemaHandle(${camel}.${field})) throw new Error("${camel}.${field} is not a Schema")
    for (const example of ${exportName}) Schema.decodeUnknownSync(${camel}.${field})(example)`
  }).join("\n")

  return `import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ${camel} } from "mag/graph-nodes/${name}/graph-node"
import { ${fixtureImports} } from "mag/graph-nodes/${name}/examples"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"

describe("${name}", () => {
  test("the fixtures decode against ${name}'s own schemas", () => {
${decodeLines}
  })

  // Delete this test once ${name} is genuinely implemented — it exists only to keep
  // \`bun test\` red until then.
  test("${name} is unimplemented", () => {
    expect(true).toBe(false)
  })
})
`
}

// Every lowercase identifier bound above in an emitted file, whether by a fixed
// import -- `make` (graph-node.ts), `describe`/`expect`/`test`/`isSchemaHandle` and `EXAMPLE_EXPORTS`
// itself (graph-node.test.ts, which imports those names from both ./examples and, via `${camel}`,
// potentially ./graph-node too) -- or by a fixed local binding: `example`, the for-of loop variable
// `testSource` emits per decode line. `toCamel(name)` landing on one is either a duplicate-declaration
// parse error or, for the loop variable, a silent shadow of the imported node inside the loop body.
// Exported so `validation.ts` checks against it instead of a second copy.
export const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  "make", "describe", "expect", "test", "isSchemaHandle", "example", ...EXAMPLE_EXPORTS
])

/** Keyed by REQUIRED_FILES, so a fifth required file becomes a compile error here. */
export const emittedFiles = (name: string, description: string): Record<(typeof REQUIRED_FILES)[number], string> => {
  const camel = toCamel(name)
  return {
    "graph-node.ts": graphNodeSource(name, description, camel),
    "errors.ts": errorsSource(name, camel),
    "graph-node.test.ts": testSource(name, camel),
    "examples.ts": examplesSource()
  }
}
