import type { Option, Schema } from "effect"
import type { Command } from "effect/unstable/cli"
import type { GraphNode } from "mag/runtime/graph-node.definition"

export type FlagKind = "string" | "number" | "boolean"

export interface FlagSpec {
  readonly field: string // maxRetries
  readonly flag: string // max-retries
  readonly kind: FlagKind
  readonly optional: boolean
  readonly help: Option.Option<string> // user-supplied annotation only
  readonly schema: Schema.Codec<unknown> // the field's own schema, optionality stripped
}

export type CommandNode = GraphNode<any, any, any, never>

/**
 * A pre-built CLI command that isn't a GraphNode — `ps` needs a human-readable table on
 * stdout, which every GraphNode's one-JSON-line-per-command contract (`render.ts`'s `renderSuccess`)
 * forecloses. `build-cli.ts`'s fold treats every entry as `AnyCommand` regardless of kind, so `any`
 * here costs nothing this fold didn't already discard.
 */
export type RegistryEntry =
  | { readonly kind: "command"; readonly node: CommandNode }
  | { readonly kind: "raw"; readonly command: Command.Command<any, any, any, any, any> }
  | { readonly kind: "group"; readonly group: string; readonly description: string; readonly children: Registry }

export type Registry = readonly RegistryEntry[]
