import { Data, Effect } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { EmptySuccess, TriggerInput } from "./common"

/** Structured, message-less failure: exercises `formatFailure`'s compact-JSON stderr branch. */
export class Boom extends Data.TaggedError("BOOM")<{
  readonly code: number
  readonly reason: string
}> {}

export const boom = make({
  name: "boom",
  description: "Always fails with a structured error that carries no message field.",
  input: TriggerInput,
  success: EmptySuccess,
  run: () => Effect.fail(new Boom({ code: 500, reason: "always fails" })),
})
