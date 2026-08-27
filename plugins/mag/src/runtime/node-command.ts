import { Effect, Option, Record, Result } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { execute } from "mag/runtime/graph-node.definition"
import { renderSuccess } from "mag/runtime/render"
import { deriveFlagSpecs } from "mag/runtime/schema-flags"
import type { CommandNode, FlagKind, FlagSpec } from "mag/runtime/types"

/** One `Flag` constructor per supported primitive kind: a new kind is a row here, not a branch. */
const flagByKind: Record<FlagKind, (flag: string) => Flag.Flag<unknown>> = {
  string: Flag.string,
  number: Flag.float,
  boolean: Flag.boolean
}

/**
 * Steps 1-2 of the per-field build, in order: `Flag.withSchema` for the field's own refinements,
 * applied to the inner flag before any optionality wrapper, then a user-supplied help
 * line when `spec.help` is `Some` — nothing added when `None`, leaving only `effect/unstable/cli`'s
 * own type blurb.
 */
const withSchemaAndHelp = (base: Flag.Flag<unknown>, spec: FlagSpec): Flag.Flag<unknown> => {
  const withSchema = Flag.withSchema(base, spec.schema)
  return Option.match(spec.help, {
    onNone: () => withSchema,
    onSome: (help) => Flag.withDescription(withSchema, help)
  })
}

/**
 * One optional-wrapping strategy for every kind: the library's own `Flag.optional`.
 *
 * This once special-cased `boolean` here, on the belief that `Flag.optional` would resolve
 * absence to `Some(false)` and break the rule that an absent optional flag must drop its key, not
 * inject one. Probed directly against this repo's `effect` (`plugins/mag/test/cli.test.ts`'s
 * cases plus a manual `--strict=false`/`--no-strict` run): `Flag.optional` on a boolean
 * flag already reads raw argv presence, not the resolved value, so absence yields `None` and an
 * explicit `--flag=false`/`--no-flag` correctly yields `Some(false)` — the belief did not hold, and
 * the custom `false -> None` collapse it produced was itself a bug, silently discarding an explicit
 * `false` as if the flag had never been passed. This is the shape `develop-graph`'s `worktree` field
 * (default `true`, explicit `--worktree=false` override) depends on.
 */
const wrapOptionalByKind: Record<FlagKind, (flag: Flag.Flag<unknown>) => Flag.Flag<unknown>> = {
  string: Flag.optional,
  number: Flag.optional,
  boolean: Flag.optional
}

/** Step 3: optionality, read from `spec.optional` alone, never re-derived from the schema. */
const withOptionality = (flag: Flag.Flag<unknown>, spec: FlagSpec): Flag.Flag<unknown> =>
  spec.optional ? wrapOptionalByKind[spec.kind](flag) : flag

const toFlag = (spec: FlagSpec): Flag.Flag<unknown> =>
  withOptionality(withSchemaAndHelp(flagByKind[spec.kind](spec.flag), spec), spec)

/**
 * `FlagSpec[] -> Record<string, Flag<unknown>>`, one entry per `spec.field`, each built by
 * `toFlag` above. The CLI library has no standalone `Flag.all` to merge this record into a single
 * `Flag<Record<string, unknown>>` before it reaches `Command.make`. `Command.make`'s config record
 * *is* the merge point: each field's `Flag` sits directly under its own key and `Command.Config.Infer`
 * reconstructs the parsed record for the handler. So the per-field map returned here is handed to
 * `Command.make` unmerged, and the one key-dropping post-processing step (absent-optional-flag
 * semantics) moves into `toCommand`'s handler below, where it runs on the actual
 * parsed values instead of on a pre-parse combinator — it is still the only place that drops keys.
 */
export const toFlags = (specs: readonly FlagSpec[]): Record<string, Flag.Flag<unknown>> => {
  const byField: Record<string, Flag.Flag<unknown>> = {}
  for (const spec of specs) {
    byField[spec.field] = toFlag(spec)
  }
  return byField
}

/**
 * One `GraphNode` -> one `Command`, or the `UnsupportedInputSchema` its input schema fails on.
 * Returning `Result` rather than throwing lets `build-cli.ts` fold this into the whole CLI's build
 * effect and fail cleanly before any argv is parsed — a thrown exception here would escape
 * as an uncaught error instead of a rendered `UNSUPPORTED_INPUT_SCHEMA` failure.
 *
 * No `Args` are declared at all, which is what makes "accepts no positional arguments"
 * structural rather than a runtime check. The handler drops every key whose parsed value is `None`
 * (the `Option` produced by the optional wrapping above) — so an absent optional flag reaches the
 * node as an absent key, never an injected default and never an explicit `undefined` —
 * then decodes the parsed flags against the node's own input schema and runs it (`execute`, reused
 * from `graph-node.definition.ts`) before rendering the success line — decoding through the node's
 * own schema rather than trusting the parsed flags directly is what makes refinements bite once.
 * The command's name and description come from the node; its place in a larger
 * command tree is registry/`build-cli.ts` work, not this function's concern.
 */
export const toCommand = (node: CommandNode) =>
  Result.map(deriveFlagSpecs(node), (specs) => {
    const flags = toFlags(specs)
    return Command.make(node.name, { flags }, (config) =>
      execute(
        node,
        Record.filterMap(config.flags, (value) =>
          Option.isOption(value)
            ? Option.match(value, { onNone: () => Result.failVoid, onSome: Result.succeed })
            : Result.succeed(value))
      ).pipe(Effect.flatMap((value) => renderSuccess(node, value)))
    ).pipe(Command.withDescription(node.description))
  })
