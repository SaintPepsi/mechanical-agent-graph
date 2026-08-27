import { Array as Arr, Effect, Option, Path, Schema } from "effect"
import { ConformanceViolations, type Violation } from "mag/graph-nodes/conformance/errors"
import { selectNodes } from "mag/graph-nodes/conformance/discovery"
import { gather } from "mag/graph-nodes/conformance/gather"
import { discoveryViolations, runRules } from "mag/graph-nodes/conformance/rules"
import { make } from "mag/runtime/graph-node.definition"
import { DEFAULT_GRAPH_NODES_ROOT } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"

/** The success value when nothing violated, otherwise CONFORMANCE_VIOLATIONS. */
const report = (root: string, checked: readonly string[], violations: readonly Violation[]) =>
  violations.length === 0 ? Effect.succeed({ root, checked }) : Effect.fail(new ConformanceViolations({ violations }))

export const conformance = make({
  name: "conformance",
  description: "Check every GraphNode directory against the required shape.",
  input: Schema.Struct({ name: Schema.optional(Schema.String), root: Schema.optional(Schema.String) }),
  success: Schema.Struct({ root: Schema.String, checked: Schema.Array(Schema.String) }),
  run: (input) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      // A relative --root resolves against the process working directory here, at the input
      // boundary. Left relative, filesystem reads would resolve against cwd while gather's dynamic
      // import() treats the same path as a bare specifier — every module Option.none(), every node
      // falsely "did not load".
      const root = input.root === undefined ? DEFAULT_GRAPH_NODES_ROOT : path.resolve(input.root)
      const { names, failures } = yield* selectNodes(root, Option.fromUndefinedOr(input.name))
      const discovered = yield* discoveryViolations(root, failures)
      const perNode = yield* Effect.forEach(
        names,
        (name) => gather(root, name).pipe(Effect.flatMap(runRules)),
        { concurrency: "unbounded" }
      )
      return yield* report(root, names, [...discovered, ...Arr.flatten(perNode)])
    }).pipe(Effect.provide(platform))
})
