import { Data } from "effect"

export interface Violation {
  readonly node: string
  readonly rule: string
  readonly file: string
  readonly detail: string
}

/** An I/O failure named by the entry it happened on. `""` is the directory itself. */
export interface IoFailure {
  readonly entry: string
  readonly detail: string
}

/** --name given but no such node under root. */
export class UnknownNode extends Data.TaggedError("CONFORMANCE_UNKNOWN_NODE")<{
  readonly name: string
  readonly root: string
}> {}

/** The graph-nodes root can't be listed/read. */
export class RootUnreadable extends Data.TaggedError("CONFORMANCE_ROOT_UNREADABLE")<{
  readonly root: string
  readonly detail: string
}> {}

/** One or more nodes failed one or more rules. */
export class ConformanceViolations extends Data.TaggedError("CONFORMANCE_VIOLATIONS")<{
  readonly violations: readonly Violation[]
}> {}
