import { Data } from "effect"

/** Nothing to break: an empty source list is an unfit input, not a session worth dispatching. */
export class BreakNoSources extends Data.TaggedError("BREAK_NO_SOURCES")<{}> {}
