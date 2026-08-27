import { join } from "node:path"
import { Option, Predicate, Schema, SchemaAST } from "effect"

/**
 * Every file a GraphNode directory must contain. The four are mandatory, and extra node-private
 * `.ts` files are allowed when owned.
 */
export const REQUIRED_FILES = ["graph-node.ts", "errors.ts", "graph-node.test.ts", "examples.ts"] as const

/** The required files whose module is loadable. `graph-node.test.ts` is source-only — a bun test file throws on `import()` and runs its body first. */
export const LOADED_FILES = REQUIRED_FILES.filter((file) => file !== "graph-node.test.ts")

/** The fields a loaded `graph-node.ts` export must carry (runtime/graph-node.definition.ts's contract). */
export const REQUIRED_NODE_FIELDS = ["name", "description", "input", "success", "run"] as const

/** Which `graph-node.ts` schema field a fixture export's entries decode against. */
export const EXAMPLE_SCHEMA_FIELDS = { inputExamples: "input", successExamples: "success" } as const

/** The fixture exports `examples.ts` must carry, each with at least one entry and a schema field above. */
export const EXAMPLE_EXPORTS = Object.keys(EXAMPLE_SCHEMA_FIELDS) as ReadonlyArray<keyof typeof EXAMPLE_SCHEMA_FIELDS>

/** Modules a node may import beyond the rest of `ALLOW_RULES` — `effect`, `node:*`, `bun:*`,
 *  `mag/runtime/*`, `mag/skills/*`, its own directory, and a sibling's `graph-node`/`errors`. */
export const TEST_SUPPORT_MODULES = ["mag/test/node-fixture"] as const

/** A scaffolded node carries this literal STRING; it must OPEN a string literal so an identifier can't fake it. */
export const UNIMPLEMENTED_MARKER = "GRAPH_NODE_UNIMPLEMENTED"

/** The directory every GraphNode is a subdirectory of — absolute, resolved from this module's own location. */
export const DEFAULT_GRAPH_NODES_ROOT = join(import.meta.dirname, "..", "graph-nodes")

/** The sibling of `DEFAULT_GRAPH_NODES_ROOT` — where the graph files themselves live, reused by `topology.ts`'s `readSource`. */
export const DEFAULT_GRAPHS_ROOT = join(import.meta.dirname, "..", "graphs")

/** `src/` itself — the parent both roots above already name their children of, and what `stage-shipped-graph` copies wholesale to build a blind derivation's working tree. */
export const DEFAULT_SRC_ROOT = join(import.meta.dirname, "..")

/**
 * The marker check and the import scan share one textual scanner rather than leaning on tsc: a
 * single pass that tracks comment, string, and regex-literal state, yielding each code-state
 * string literal's body plus the code text just before it. State-awareness is load bearing both
 * ways: a quoted marker inside a `//` comment must not count as carrying the scaffold marker, and
 * an import-shaped phrase inside another string's body (a `description` mentioning `from 'fs'`)
 * must not count as a real import — both were live misclassifications when this was a bare regex
 * over raw source.
 *
 * `start` is the literal's own offset in `source` — needed for `topology.ts`'s `nodeBindings`,
 * which reads `masked` immediately before a literal it has already found, not just the compacted
 * `before` lookbehind window `SPECIFIER_PREFIX`/`REGEX_CAN_FOLLOW` test against.
 */
type StringLiteral = { readonly body: string; readonly before: string; readonly start: number }

/**
 * Code endings after which a `/` opens a regex literal rather than dividing — without this, a regex
 * containing a quote (`/["']/`) opens a phantom string and desyncs the scan. `+`/`-` are deliberately
 * NOT bare chars in the class: a postfix `i++`/`i--` ends in the same character, and treating that as
 * "a value expects a regex next" opens a phantom regex on the following `/` of ordinary division
 * (`i++ / 2` inside a `for` block once swallowed the loop's own closing brace into the phantom
 * regex, corrupting every step's depth after it). The
 * negative lookbehind rejects a doubled operator while still allowing a genuine single `+`/`-` before
 * a regex (`x = a + /abc/`).
 */
const REGEX_CAN_FOLLOW =
  /(?:^|[(,=:[!&|?{};*%<>~^]|(?<![+-])[+-]|\breturn|\btypeof|\bcase|\bdo|\belse|\byield|\bawait|\bvoid|\bdelete|\bnew|\bin|\bof)\s*$/

/**
 * One open template literal's scanning state. A template alternates between "body" text
 * (masked, decoded like any other quoted literal's characters) and, once a `${` is seen, "code" —
 * scanned by the exact same rules as top-level source, including nested templates, which is why this
 * is a stack rather than a flag: `` `${ `nested` }` `` opens a second frame while the first is still
 * mid-substitution. `braceDepth` is the current substitution's own nesting (an object literal or a
 * block inside `${...}`), so the `}` that actually closes the substitution — the one at depth 0 — is
 * distinguished from one that belongs to the code inside it.
 */
interface TemplateFrame {
  readonly start: number
  readonly before: string
  body: string
  inCode: boolean
  braceDepth: number
}

/**
 * The scan's second projection, alongside the literal list `import-surface` and
 * `unimplemented-progress` read. `masked` is a second, independent accumulator built in the same
 * pass: every comment, regex literal, and non-code span of a string or template literal is
 * replaced by spaces of the same length, so `masked.length === source.length` and every surviving
 * character sits at its real source offset — a projection `topology.ts` needs and `code` cannot give,
 * since `code` throws offsets away by design.
 *
 * A template literal's `${...}` substitutions are real code and stay visible in `masked` (a flat
 * "whole template is not-code" treatment would blank `` `${alpha.run(1)}` `` entirely, losing the
 * step; a naive unnested backtick match would also let `` `${ `}` }` `` leak an unmatched `}` from
 * a nested template's own text into the surrounding brace count). `code` keeps its shape exactly:
 * while any template is open (`templates.length > 0`), it does not grow at all, and gains exactly
 * one `"0"` when the outermost one fully closes — the same "one literal, one opaque marker"
 * contract quote-strings already had, so the `before`-window lookbehinds
 * `SPECIFIER_PREFIX`/`REGEX_CAN_FOLLOW` test against are byte-for-byte unchanged for any source
 * that isn't itself inside a template's `${...}` (regex detection inside a substitution is a
 * known, untested gap: `code`'s lookback there is frozen from just before the template opened).
 */
export const scan = (source: string): { readonly literals: readonly StringLiteral[]; readonly masked: string } => {
  const literals: Array<StringLiteral> = []
  let code = ""
  let masked = ""
  let i = 0
  const templates: Array<TemplateFrame> = []

  while (i < source.length) {
    const top = templates[templates.length - 1]

    if (top !== undefined && !top.inCode) {
      // Template body text: not code, masked as spaces, decoded like any other literal's body.
      const ch = source[i]
      if (ch === "\\") {
        const next = source[i + 1]
        top.body += next ?? ""
        const step = next === undefined ? 1 : 2
        masked += " ".repeat(step)
        i += step
        continue
      }
      if (ch === "$" && source[i + 1] === "{") {
        top.inCode = true
        top.braceDepth = 0
        masked += "  "
        i += 2
        continue
      }
      if (ch === "`") {
        literals.push({ body: top.body, before: top.before, start: top.start })
        masked += " "
        i += 1
        templates.pop()
        if (templates.length === 0) code += "0"
        continue
      }
      top.body += ch
      masked += " "
      i += 1
      continue
    }

    // Code state: top-level (no open template), or inside a template's `${...}` substitution.
    const ch = source[i]
    if (ch === "/" && source[i + 1] === "/") {
      const start = i
      const end = source.indexOf("\n", i)
      i = end === -1 ? source.length : end
      masked += " ".repeat(i - start)
      continue
    }
    if (ch === "/" && source[i + 1] === "*") {
      const start = i
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      masked += " ".repeat(i - start)
      continue
    }
    if (ch === "/" && REGEX_CAN_FOLLOW.test(code.slice(-16))) {
      const start = i
      let inClass = false
      i++
      while (i < source.length && (inClass || source[i] !== "/") && source[i] !== "\n") {
        if (source[i] === "\\") i++
        else if (source[i] === "[") inClass = true
        else if (source[i] === "]") inClass = false
        i++
      }
      // Clamped rather than a bare `i++` (the original shape): an unterminated regex literal would
      // otherwise walk `i` one past `source.length`, and `masked`'s own invariant — same length as
      // `source` — has to hold even on malformed input, not just on the well-formed files this scan
      // was written for.
      i = Math.min(i + 1, source.length)
      if (top === undefined) code += "0"
      masked += " ".repeat(i - start)
      continue
    }
    if (ch === "\"" || ch === "'") {
      const start = i
      let body = ""
      let j = i + 1
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\") {
          body += source[j + 1] ?? ""
          j += 2
          continue
        }
        body += source[j]
        j++
      }
      literals.push({ body, before: code.slice(-32), start })
      if (top === undefined) code += "0"
      // Clamped for the same reason as the regex branch: an unterminated string must not push `i`
      // past `source.length` and desync `masked`'s length from `source`'s.
      i = Math.min(j + 1, source.length)
      masked += " ".repeat(i - start)
      continue
    }
    if (ch === "`") {
      templates.push({ start: i, before: code.slice(-32), body: "", inCode: false, braceDepth: 0 })
      masked += " "
      i += 1
      continue
    }

    // A plain code character. Inside a substitution, `{`/`}` need bookkeeping to find the `}` that
    // closes it (depth 0) rather than one belonging to the substitution's own nested code — checked
    // here, after the comment/regex/string/backtick branches above, so a brace inside any of those
    // (a regex character class, a string body) never reaches this counter.
    if (top !== undefined) {
      if (ch === "{") {
        top.braceDepth += 1
      } else if (ch === "}") {
        if (top.braceDepth === 0) {
          top.inCode = false
          masked += " "
          i += 1
          continue
        }
        top.braceDepth -= 1
      }
    }
    if (top === undefined) code += ch
    masked += ch
    i++
  }
  return { literals, masked }
}

/** `import-surface`/`unimplemented-progress`'s own literal list, unchanged behaviour: `scan`'s other projection. */
const stringLiterals = (source: string): readonly StringLiteral[] => scan(source).literals

/** What real specifier positions end with — `from ` (never `Array.from(`, hence no paren on that branch and the lookbehind against `.`), bare or dynamic `import`, `require(`. */
export const SPECIFIER_PREFIX = /(?<![.\w$])(?:from\s*|import\s*\(?\s*|require\s*\(\s*)$/

export const importSpecifiers = (source: string): readonly string[] =>
  stringLiterals(source)
    .filter((literal) => SPECIFIER_PREFIX.test(literal.before))
    .map((literal) => literal.body)

/** The one home of a node's own directory prefix — the allowlist row and the reachability matcher both read it. */
const selfSpecifier = (nodeName: string) => `mag/graph-nodes/${nodeName}`

/**
 * A sibling node's own PUBLIC contract — its made export (`graph-node`) and its declared error
 * classes (`errors`), never a sibling's private files (`examples.ts`, internal helpers). This is
 * the seam that lets a node compose other nodes (`publish` calling `pushBranch`/`createPr`)
 * without opening the ownership closure the `extra-file-ownership` rule protects.
 */
const siblingPublicSurface = (specifier: string, nodeName: string): boolean => {
  const match = /^mag\/graph-nodes\/([^/]+)\/(graph-node|errors)$/.exec(specifier)
  return match !== null && match[1] !== nodeName
}

/** One predicate row per allowed prefix — a new allowed prefix is a row, not a branch. */
const ALLOW_RULES: ReadonlyArray<(specifier: string, nodeName: string) => boolean> = [
  (specifier) => specifier === "effect" || specifier.startsWith("effect/"),
  (specifier) => specifier.startsWith("node:"),
  (specifier) => specifier.startsWith("bun:"),
  (specifier) => specifier === "mag/runtime" || specifier.startsWith("mag/runtime/"),
  (specifier, nodeName) =>
    specifier === selfSpecifier(nodeName) || specifier.startsWith(`${selfSpecifier(nodeName)}/`),
  (specifier) => (TEST_SUPPORT_MODULES as readonly string[]).includes(specifier),
  siblingPublicSurface,
  // Skills are an audited shared seam, like `mag/runtime` — a node compiles a skill variant
  // inside its own runtime, at dispatch, rather than owning a copy of the definition. Deliberate
  // widening, scoped to this one namespace, not a general escape hatch.
  (specifier) => specifier === "mag/skills" || specifier.startsWith("mag/skills/"),
]

export const isAllowedImport = (specifier: string, nodeName: string): boolean =>
  ALLOW_RULES.some((rule) => rule(specifier, nodeName))

/** An absolute self-directory specifier → the sibling filename it names, `.ts` implied. */
export const nodeInternalTarget = (specifier: string, nodeName: string): Option.Option<string> => {
  const prefix = `${selfSpecifier(nodeName)}/`
  if (!specifier.startsWith(prefix)) return Option.none()
  const remainder = specifier.slice(prefix.length)
  if (remainder.length === 0) return Option.none()
  return Option.some(remainder.endsWith(".ts") ? remainder : `${remainder}.ts`)
}

/**
 * Does `graphNodeSource` still open a string literal with `UNIMPLEMENTED_MARKER`? Reading the
 * loaded `run`'s `String()` is banned (an `Effect.fn` wrapper's source hides the generator body), so this
 * scans the file's own text instead. An import, a local binding named after the token, or the token
 * quoted inside a comment doesn't count.
 */
export const carriesUnimplementedMarker = (graphNodeSource: string): boolean =>
  stringLiterals(graphNodeSource).some((literal) => literal.body.startsWith(UNIMPLEMENTED_MARKER))

/** The one object a conforming `graph-node.ts` exports, by name unpinned. */
export const singleObjectExport = (loadedModule: Record<string, unknown>): Option.Option<Record<string, unknown>> => {
  const objectExports = Object.values(loadedModule).filter(Predicate.isObject)
  return objectExports.length === 1 ? Option.some(objectExports[0] as Record<string, unknown>) : Option.none()
}

/**
 * Walks the prototype chain for an OWN `name` above the candidate's own prototype — what
 * `Data.TaggedError`/`Schema.TaggedError` set — stopping at `Error.prototype`/`Object.prototype`,
 * whose inherited `name` never counts. Never constructs `candidate`: `new SchemaTaggedError({})` throws.
 */
export const taggedErrorTag = (candidate: unknown): string | undefined => {
  if (!Predicate.isFunction(candidate)) return undefined

  // The prototype chain has no static type, so the walk is `unknown`-in / `string | undefined`-out.
  let level: object | null = (candidate.prototype as object | undefined) ?? null
  while (level !== null && level !== Error.prototype && level !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(level, "name")
    if (descriptor !== undefined && Predicate.isString(descriptor.value) && descriptor.value.length > 0) {
      return descriptor.value
    }
    level = Object.getPrototypeOf(level)
  }
  return undefined
}

/** An empty struct is `Schema.Struct({})` — an `Objects` AST node with zero property signatures. */
export const isEmptyStructSchema = (schema: unknown): boolean => {
  const ast = (schema as Schema.Codec<unknown> | undefined)?.ast
  return ast !== undefined && SchemaAST.isObjects(ast) && ast.propertySignatures.length === 0
}

/**
 * A scaffold-placeholder value on `input`/`success` (e.g. `{}`) is not a `Schema` at all, and
 * `Schema.decodeUnknownEffect` dies rather than fails when handed one. `Schema.isSchema` turns
 * that die into a named `examples-decode` violation instead of an unhandled defect.
 */
export const isSchemaHandle = (candidate: unknown): candidate is Schema.Codec<unknown> => Schema.isSchema(candidate)
