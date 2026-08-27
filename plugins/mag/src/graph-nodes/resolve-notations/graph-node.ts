import { Effect, Result, Schema } from "effect"
import { UnknownStackVerdict } from "mag/graph-nodes/resolve-notations/errors"
import { make } from "mag/runtime/graph-node.definition"
import { notationsFor, STACKS } from "mag/skills/design/envisioning"

/**
 * Turns the three stack probes' verdicts into the notation list `envision-visions` fans out over:
 * ids in, ids out, with no prompt composition attached. The positional shape `{ verdicts }` is the
 * three probes' own success shape, so their results drop straight in without reshaping.
 *
 * `notationsFor` is the one home for "which notations exist and what a non-match resolves to"
 * (`skills/design/envisioning.ts`); this node's only job is turning its `Result`'s failure into a
 * named error before any session is dispatched. No disk, no context: three verdicts in, a notation
 * list or a named failure out. `verdicts` is an array, so this node stays absent from `registry.ts`
 * the same way `format-branch-name` is (`schema-flags.ts` derives CLI flags for
 * string/number/boolean only).
 */
export const resolveNotations = make({
  name: "resolve-notations",
  description: "Turn the three stack probes' verdicts into the notation list a design run draws.",
  input: Schema.Struct({
    verdicts: Schema.Array(Schema.Struct({ stack: Schema.String, matched: Schema.Boolean }))
  }),
  success: Schema.Struct({
    notations: Schema.Array(Schema.String)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const matched = input.verdicts.filter((verdict) => verdict.matched).map((verdict) => verdict.stack)
      const resolved = notationsFor(matched)
      if (Result.isFailure(resolved)) {
        return yield* Effect.fail(new UnknownStackVerdict({ id: resolved.failure, known: STACKS.map((stack) => stack.id) }))
      }

      return { notations: resolved.success }
    })
})
