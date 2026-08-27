import { Effect, Schema } from "effect"
import { createFolder } from "mag/graph-nodes/create-graph-folder/folder"
import { make } from "mag/runtime/graph-node.definition"
import { DEFAULT_GRAPHS_ROOT } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"

/**
 * The mechanical step every envision run starts from — resolves a graph name to its own
 * source folder under `plugins/mag/src/graphs/` and creates it when absent, so both visions have
 * somewhere to land before any model session is dispatched. `DEFAULT_GRAPHS_ROOT` is hardwired here,
 * `create/graph-node.ts`'s own precedent for its sibling root: the live default is this node's whole
 * behaviour, not an input a caller overrides.
 */
export const createGraphFolder = make({
  name: "create-graph-folder",
  description: "Resolve a graph name to its own source folder and create it when absent.",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({ folder: Schema.String, created: Schema.Boolean }),
  run: (input) => createFolder(DEFAULT_GRAPHS_ROOT, input.name).pipe(Effect.provide(platform))
})
