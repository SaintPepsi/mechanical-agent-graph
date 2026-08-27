import { Data } from "effect"

/**
 * `isSafeSegment` rejected `name` before any directory was touched — `run-layers.ts`'s own
 * ticket-id gate, mirrored here for a graph name. Unfit paths error;
 * this dies named rather than being worked around.
 */
export class UnsafeGraphName extends Data.TaggedError("UNSAFE_GRAPH_NAME")<{
  readonly name: string
}> {}

/** The folder could not be created — a platform error caught and named, `create/scaffold.ts`'s `ScaffoldFailed` precedent. */
export class GraphFolderCreateFailed extends Data.TaggedError("GRAPH_FOLDER_CREATE_FAILED")<{
  readonly folder: string
  readonly detail: string
}> {}
