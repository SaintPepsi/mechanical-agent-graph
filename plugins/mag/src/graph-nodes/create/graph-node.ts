import { Effect, Schema } from "effect"
import { scaffold } from "mag/graph-nodes/create/scaffold"
import { make } from "mag/runtime/graph-node.definition"
import { DEFAULT_GRAPH_NODES_ROOT } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"

export const create = make({
  name: "create",
  description: "Create a new GraphNode directory from the template.",
  input: Schema.Struct({ name: Schema.String, description: Schema.String }),
  success: Schema.Struct({ directory: Schema.String }),
  run: (input) => scaffold(DEFAULT_GRAPH_NODES_ROOT, input).pipe(Effect.provide(platform))
})
