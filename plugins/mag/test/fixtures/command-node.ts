import { Effect, Schema } from "effect"
import type { CommandNode } from "mag/runtime/types"

/** A minimal CommandNode fixture: only `name`, `description` and `input` are read by the fold. */
export const fixtureNode = (name: string, input: Schema.Schema<any>): CommandNode =>
  ({
    name,
    description: "fixture node",
    input,
    success: Schema.Void,
    run: () => Effect.void
  }) as CommandNode
