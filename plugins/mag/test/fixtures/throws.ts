import { Effect } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { EmptySuccess, TriggerInput } from "./common"

/** Raw, untyped throw inside `run` — exercises the defect path `Effect.catchAllDefect` guards, not the `E` channel. */
export const throwsFixture = make({
  name: "throws",
  description: "Always throws a raw error instead of failing with a typed error.",
  input: TriggerInput,
  success: EmptySuccess,
  run: () =>
    Effect.sync(() => {
      throw new Error("unexpected raw throw")
    }),
})
