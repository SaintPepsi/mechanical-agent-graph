import { Data } from "effect"

/**
 * A verdict names an id no `STACKS` row carries. The empty-match answer is decided here and nowhere
 * else, so no later node re-derives which situation this is from a list's length.
 * A caller mistake (a probe renamed, a typo'd id), never a silent drop to generic.
 */
export class UnknownStackVerdict extends Data.TaggedError("UNKNOWN_STACK_VERDICT")<{
  readonly id: string
  readonly known: readonly string[]
}> {}
