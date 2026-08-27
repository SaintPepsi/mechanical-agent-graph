import { Data } from "effect"

/** A command node's input schema is not a flat struct of supported primitives. */
export class UnsupportedInputSchema extends Data.TaggedError("UNSUPPORTED_INPUT_SCHEMA")<{
  readonly node: string
  readonly field: string
  readonly type: string
}> {}
