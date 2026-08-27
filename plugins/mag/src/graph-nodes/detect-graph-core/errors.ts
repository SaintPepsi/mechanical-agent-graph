import { Data } from "effect"

/**
 * A manifest path exists but the read failed for any `PlatformError` reason other than `NotFound`
 * (`readManifests`' own `onUnreadable`), or the workspace glob itself failed. Distinct from a
 * missing manifest, which `readManifests` absorbs as a clean `[]` before this node ever sees it.
 */
export class GraphCoreManifestUnreadable extends Data.TaggedError("GRAPH_CORE_MANIFEST_UNREADABLE")<{
  readonly path: string
  readonly detail: string
}> {}

/** A manifest read fine and is not JSON, or is JSON that is not an object. A repo whose manifest cannot be parsed is a repo this probe cannot answer about. */
export class GraphCoreManifestMalformed extends Data.TaggedError("GRAPH_CORE_MANIFEST_MALFORMED")<{
  readonly path: string
  readonly detail: string
}> {}
