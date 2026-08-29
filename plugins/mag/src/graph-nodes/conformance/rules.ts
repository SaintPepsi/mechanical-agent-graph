import { Array as Arr, Effect, Option, Path, Predicate, Result, Schema, SchemaAST } from "effect"
import type { IoFailure, Violation } from "mag/graph-nodes/conformance/errors"
import type { NodeUnderCheck } from "mag/graph-nodes/conformance/gather"
import { ownedFiles, subjectFileFor } from "mag/graph-nodes/conformance/ownership"
import { isJournaled } from "mag/runtime/journal/journaled"
import {
  carriesUnimplementedMarker,
  EXAMPLE_EXPORTS,
  EXAMPLE_SCHEMA_FIELDS,
  importSpecifiers,
  isAllowedImport,
  isEmptyStructSchema,
  isSchemaHandle,
  REQUIRED_FILES,
  REQUIRED_NODE_FIELDS,
  singleObjectExport,
  taggedErrorTag
} from "mag/runtime/graph-node.shape"

/** The only `Violation` constructor, and the only `join` call site — a rule can only name itself, and never builds a path. */
type Flag = (entry: string, detail: string) => Violation
const flagFor = (node: string, rule: string, dir: string, join: Path.Path["join"]): Flag =>
  (entry, detail) => ({ node, rule, file: join(dir, entry), detail })

/** The rule catalog: one row per shape rule, each reading only the shared snapshot. */
interface Rule {
  readonly id: string
  readonly check: (subject: NodeUnderCheck, flag: Flag) => Effect.Effect<readonly Violation[]>
}

/** Most rules need no Effect — `pure` lifts a plain function over the snapshot into the `Rule` shape. */
const pure = (id: string, check: (subject: NodeUnderCheck, flag: Flag) => readonly Violation[]): Rule =>
  ({ id, check: (subject, flag) => Effect.succeed(check(subject, flag)) })

/** One id for the node-level rule row and the root-level renderer, so they cannot drift. */
const READ_FAILURE = "read-failure"

/** An I/O failure the snapshot carries is a violation like any other. */
const readFailure = pure(READ_FAILURE, (subject, flag) =>
  subject.failures.map((failure) => flag(failure.entry, failure.detail)))

/** One of `LOADED_FILES`' modules, `Option.none()` when it failed to import or was never loaded. */
const loaded = (subject: NodeUnderCheck, file: string) => subject.modules.get(file) ?? Option.none()

/** Every entry in REQUIRED_FILES exists under the node's own directory. */
const requiredFiles = pure("required-files", (subject, flag) =>
  REQUIRED_FILES.filter((file) => !subject.sources.has(file))
    .map((file) => flag(file, `missing required file: ${file}`))
)

/** An extra entry that is a directory or not a `.ts` file — junk, never routed through reachability. */
const noExtraEntries = pure("no-extra-entries", (subject, flag) =>
  subject.extraJunk.map((entry) => flag(entry, `unexpected entry: ${entry}`))
)

/** An extra `.ts` file no required file reaches, or a test file with no owned sibling. */
const extraFileOwnership = pure("extra-file-ownership", (subject, flag) => {
  const owned = ownedFiles(subject.sources, subject.name)

  return subject.extraSources
    .filter((file) => !owned.has(file))
    .map((file) => {
      const subjectFile = subjectFileFor(file)
      return Option.isNone(subjectFile)
        ? flag(file, `unowned extra file: ${file}`)
        : flag(file, `unowned extra test file: ${file} (no owned sibling ${subjectFile.value})`)
    })
})

/** `graph-node.ts` exports exactly one object, carrying every REQUIRED_NODE_FIELDS name. */
const nodeExport = pure("node-export", (subject, flag) => {
  const file = "graph-node.ts"

  return Option.match(loaded(subject, "graph-node.ts"), {
    onNone: () => [flag(file, "graph-node.ts did not load")],
    onSome: (loadedModule) =>
      Option.match(singleObjectExport(loadedModule), {
        onNone: () => {
          const found = Object.values(loadedModule).filter(Predicate.isObject).length
          return [flag(file, `expected exactly one object export, found ${found}`)]
        },
        onSome: (graphNode) =>
          REQUIRED_NODE_FIELDS.filter((field) => !Predicate.hasProperty(graphNode, field))
            .map((field) => flag(file, `missing field: ${field}`))
      })
  })
})

/** `errors.ts` exports at least one tagged error class. */
const taggedErrorExport = pure("tagged-error-export", (subject, flag) => {
  const file = "errors.ts"

  return Option.match(loaded(subject, "errors.ts"), {
    onNone: () => [flag(file, "errors.ts did not load")],
    onSome: (loadedModule) =>
      Object.values(loadedModule).some((candidate) => taggedErrorTag(candidate) !== undefined)
        ? []
        : [flag(file, "no exported tagged error class (an own `name` on the prototype chain)")]
  })
})

/**
 * Every `EXAMPLE_EXPORTS` name is a non-empty array — empty is a violation — whose entries decode
 * against the matching schema on the loaded `graph-node.ts` export. The one rule needing an Effect,
 * since decoding is one. A missing dependency names itself rather than crashing the rule.
 */
const examplesDecode: Rule = {
  id: "examples-decode",
  check: (subject, flag) =>
    Effect.gen(function* () {
      const file = "examples.ts"
      const examplesModule = loaded(subject, "examples.ts")
      if (Option.isNone(examplesModule)) return [flag(file, "examples.ts did not load")]

      const violations: Violation[] = []
      const toDecode: Array<{ readonly field: "input" | "success"; readonly fixtures: readonly unknown[] }> = []

      for (const exportName of EXAMPLE_EXPORTS) {
        const value = examplesModule.value[exportName]
        if (!Array.isArray(value) || value.length === 0) {
          violations.push(flag(file, `${exportName} is missing, not an array, or empty`))
          continue
        }
        toDecode.push({ field: EXAMPLE_SCHEMA_FIELDS[exportName], fixtures: value })
      }

      if (toDecode.length === 0) return violations

      const nodeModule = loaded(subject, "graph-node.ts")
      if (Option.isNone(nodeModule)) {
        const detail = "examples.ts needs graph-node.ts's schemas, but graph-node.ts did not load"
        violations.push(flag("graph-node.ts", detail))
        return violations
      }

      // An ambiguous export shape is `node-export`'s violation; without exactly one object export
      // there is no schema pair to decode against, so this rule has nothing to check.
      const graphNode = singleObjectExport(nodeModule.value)
      if (Option.isNone(graphNode)) return violations

      for (const { field, fixtures } of toDecode) {
        // The loaded node's schemas are `unknown` fields on an untyped module; decoding is their only
        // use and a decode failure is the violation.
        const schema = graphNode.value[field]
        if (!isSchemaHandle(schema)) {
          violations.push(flag("graph-node.ts", `${field} is not a Schema`))
          continue
        }
        for (const fixture of fixtures) {
          const decoded = yield* Effect.result(Schema.decodeUnknownEffect(schema)(fixture))
          if (Result.isFailure(decoded)) violations.push(flag(file, decoded.failure.message))
        }
      }

      return violations
    })
}

/**
 * A violation only when BOTH schemas are empty structs AND the scaffold marker is gone from
 * `graph-node.ts`'s source text. An unloaded or ambiguous export shape is `node-export`'s violation,
 * not this one. The marker half reads source, never the loaded `run`: an `Effect.fn` wrapper's
 * `String()` is the combinator's own source, not the generator body, and would hide a marker that's
 * still there.
 */
const unimplementedProgress = pure("unimplemented-progress", (subject, flag) => {
  const nodeExportOption = Option.flatMap(loaded(subject, "graph-node.ts"), singleObjectExport)
  if (Option.isNone(nodeExportOption)) return []

  const nodeExportValue = nodeExportOption.value
  const bothEmpty = isEmptyStructSchema(nodeExportValue["input"]) && isEmptyStructSchema(nodeExportValue["success"])
  const markerGone = !carriesUnimplementedMarker(subject.sources.get("graph-node.ts") ?? "")
  const detail = "input and success schemas are both empty structs and the unimplemented marker is gone from graph-node.ts"

  return bothEmpty && markerGone ? [flag("graph-node.ts", detail)] : []
})

/**
 * Every node must be built by `make` (`mag/runtime/graph-node.definition`), because `make` is
 * where `journaled` is applied — an export assembled by hand satisfies the `GraphNode` interface,
 * registers, and runs, but its runs leave no journal row, and nothing else in the system would say
 * so. This rule is what turns that silence into a violation. An export that is unloaded, ambiguous,
 * or missing required fields is `node-export`'s violation, not this one.
 */
const journaledConstruction = pure("journaled-construction", (subject, flag) => {
  const nodeExportOption = Option.flatMap(loaded(subject, "graph-node.ts"), singleObjectExport)
  if (Option.isNone(nodeExportOption)) return []

  const nodeExportValue = nodeExportOption.value
  const completeShape = REQUIRED_NODE_FIELDS.every((field) => Predicate.hasProperty(nodeExportValue, field))
  const detail =
    "not built by make(): the export lacks the journal marker, so its runs would leave no record " +
    "— construct it with make() from mag/runtime/graph-node.definition"

  return completeShape && !isJournaled(nodeExportValue) ? [flag("graph-node.ts", detail)] : []
})

/** Every source file may only import specifiers allowed for this node — one violation per rejected specifier. */
const importSurface = pure("import-surface", (subject, flag) =>
  [...subject.sources].flatMap(([filename, text]) =>
    importSpecifiers(text)
      .filter((specifier) => !isAllowedImport(specifier, subject.name))
      .map((specifier) => flag(filename, `disallowed import: ${specifier}`))
  )
)

/**
 * The ticket-driven nodes that read a second stage artifact by ruling, each with the ruling that
 * names why (`PRINCIPLES.md`, "A node's required inputs are the ticket plus the one artifact of
 * the stage before it"). A third row here is a ruling first, an entry second.
 */
export const INPUT_BOUNDARY_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ["plan", "the plan resolves names against the repo, v1's Resolution Table position"]
])

/** The one field every ticket-driven node carries, the ruling's own baseline; a node without it is not a stage of a ticket's pipeline and is outside the ruling. */
const TICKET_FIELD = "ticketPath"

/**
 * A ticket-driven node's required inputs are the ticket plus the one artifact of the stage before
 * it: every required `...Path` field beside `ticketPath` is a stage artifact, and a second one is a
 * violation unless the node is in `INPUT_BOUNDARY_EXCEPTIONS` with its ruling. Optional paths are
 * loop state (`findingsPath`, `disputePath`, `priorFindingsPath`), never a stage input, so only
 * required keys count. An unloaded or ambiguous export is `node-export`'s violation, not this one.
 */
const inputBoundary = pure("input-boundary", (subject, flag) => {
  const nodeExportOption = Option.flatMap(loaded(subject, "graph-node.ts"), singleObjectExport)
  if (Option.isNone(nodeExportOption)) return []
  const input = nodeExportOption.value["input"]
  if (!isSchemaHandle(input) || !SchemaAST.isObjects(input.ast)) return []

  const names = input.ast.propertySignatures.map((signature) => String(signature.name))
  if (!names.includes(TICKET_FIELD)) return []
  const artifacts = input.ast.propertySignatures
    .filter((signature) => String(signature.name).endsWith("Path") && String(signature.name) !== TICKET_FIELD && !SchemaAST.isOptional(signature.type))
    .map((signature) => String(signature.name))
  if (artifacts.length <= 1 || INPUT_BOUNDARY_EXCEPTIONS.has(subject.name)) return []

  const detail =
    `reads ${artifacts.length} stage artifacts beside the ticket (${artifacts.join(", ")}): ` +
    "the ticket plus one artifact is the boundary, a second needs a ruling in INPUT_BOUNDARY_EXCEPTIONS naming why"
  return [flag("graph-node.ts", detail)]
})

const RULES: readonly Rule[] = [
  readFailure,
  requiredFiles,
  noExtraEntries,
  extraFileOwnership,
  nodeExport,
  taggedErrorExport,
  examplesDecode,
  unimplementedProgress,
  journaledConstruction,
  importSurface,
  inputBoundary
]

/** Every rule gets a reporter bound to its own id and to this node's directory. */
export const runRules = Effect.fn("runRules")(function* (subject: NodeUnderCheck) {
  const path = yield* Path.Path
  return yield* Effect.forEach(RULES, (rule) =>
    rule.check(subject, flagFor(subject.name, rule.id, subject.dir, path.join))
  ).pipe(Effect.map(Arr.flatten))
})

/**
 * A root entry we could not classify — the entry name *is* the node name (`discovery.ts`'s `StatResult`). Each
 * failure gets its own one-off `flagFor` closure (rather than one shared across the whole root)
 * because `flagFor` binds a single node for its whole `Flag`, and at the root level every failure
 * names a *different* node.
 */
export const discoveryViolations = Effect.fn("discoveryViolations")(function* (
  root: string,
  failures: readonly IoFailure[]
) {
  const path = yield* Path.Path
  return failures.map((failure) => flagFor(failure.entry, READ_FAILURE, root, path.join)(failure.entry, failure.detail))
})
