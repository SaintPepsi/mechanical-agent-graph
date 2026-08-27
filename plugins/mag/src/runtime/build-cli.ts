import { Array as Arr, Effect, Result } from "effect"
import { Command } from "effect/unstable/cli"
import type { UnsupportedInputSchema } from "mag/runtime/errors"
import { toCommand } from "mag/runtime/node-command"
import type { Registry, RegistryEntry } from "mag/runtime/types"

/**
 * The fold only cares that every node in the tree is *some* command; the exact R/E/A of any one
 * node stops mattering once it's a subcommand under `mag`.
 */
export type AnyCommand = Command.Command<any, any, any, any, any>

/** `Command.withSubcommands` demands a non-empty tuple; a childless level is still a valid,
 * help-printing command, so an empty registry (or a group with no children) folds rather than fails. */
const withChildren = (command: AnyCommand, children: readonly AnyCommand[]): AnyCommand =>
  Arr.isReadonlyArrayNonEmpty(children) ? Command.withSubcommands(command, children) : command

/**
 * One `RegistryEntry` -> one `Command`, or the `UnsupportedInputSchema` that entry (a `command`
 * leaf) or any of its descendants (a `group`'s children) fails on.
 */
const foldEntry = (entry: RegistryEntry): Result.Result<AnyCommand, UnsupportedInputSchema> => {
  if (entry.kind === "command") {
    return toCommand(entry.node)
  }

  // A "raw" entry already IS a Command — folded in unchanged, the same way a "command"
  // entry's GraphNode becomes one via `toCommand`.
  if (entry.kind === "raw") {
    return Result.succeed(entry.command)
  }

  return Result.map(foldRegistry(entry.children), (children) =>
    withChildren(Command.make(entry.group).pipe(Command.withDescription(entry.description)), children))
}

/**
 * A `Registry` -> its commands, or the first `UnsupportedInputSchema` found anywhere in the tree.
 * `Result.all` fails the whole fold the moment one entry does — a bad sibling never gets folded
 * into a partially-built tree, whether it's top-level or nested inside a group.
 */
const foldRegistry = (registry: Registry): Result.Result<readonly AnyCommand[], UnsupportedInputSchema> =>
  Result.all(registry.map(foldEntry))

/**
 * Fold the registry tree into the root `mag` command. Every `command` leaf goes through
 * `toCommand`; every `group` becomes `Command.make` + `withDescription` + (non-empty-only)
 * `withSubcommands`. An empty registry is itself just a childless root, so it both compiles and
 * runs.
 */
export const buildCli = (registry: Registry): Effect.Effect<AnyCommand, UnsupportedInputSchema> =>
  Effect.gen(function* () {
    const children = yield* Effect.fromResult(foldRegistry(registry))
    return withChildren(Command.make("mag"), children)
  })
