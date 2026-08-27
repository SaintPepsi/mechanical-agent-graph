import { Effect, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"

/**
 * A nested `Schema.Struct` input — not a flat struct of supported primitives, so
 * `deriveFlagSpecs` rejects it with `UnsupportedInputSchema` and the whole CLI build fails before
 * any argv is parsed. Used only by the unsupported-schema harness, never registered in
 * `fixtureRegistry`.
 */
export const badInput = make({
  name: "bad-input",
  description: "Input schema is a nested struct, deliberately unsupported by the CLI builder.",
  input: Schema.Struct({ nested: Schema.Struct({ x: Schema.String }) }),
  success: Schema.Struct({}),
  run: () => Effect.succeed({}),
})
