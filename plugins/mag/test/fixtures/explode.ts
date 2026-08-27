import { Data, Effect } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { EmptySuccess, TriggerInput } from "./common"

/** Failure that carries a `message` field: exercises `formatFailure`'s `TAG: message` stderr branch. */
export class Explode extends Data.TaggedError("EXPLODE")<{
  readonly message: string
}> {}

export const explode = make({
  name: "explode",
  description: "Always fails with an error that carries a message field.",
  input: TriggerInput,
  success: EmptySuccess,
  run: () => Effect.fail(new Explode({ message: "everything is on fire" })),
})
