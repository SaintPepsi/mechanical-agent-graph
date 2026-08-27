import { Data } from "effect"

/** `<DEFAULT_GRAPHS_ROOT>/<name>/graph.ts` is absent — the name resolves to no shipped graph. */
export class GraphSourceMissing extends Data.TaggedError("GRAPH_SOURCE_MISSING")<{
  readonly name: string
  readonly looked: string
}> {}

/**
 * The graph ships without a co-located vision. A review against nothing would report a clean bill it
 * never earned. Tagged `STAGE_VISION_MISSING`, not the bare `VISION_MISSING` `envision-mermaid/errors.ts`
 * already owns: the journal's fail event carries only `_tag` (`runtime/trace/outcome.ts`), so two nodes
 * sharing a tag make one row unattributable. `envision-notation/errors.ts`'s `NotationVisionMissing`
 * (`NOTATION_VISION_MISSING`) is the precedent for the same node-scoped prefix.
 */
export class ShippedVisionMissing extends Data.TaggedError("STAGE_VISION_MISSING")<{
  readonly name: string
  readonly searchedIn: string
}> {}

/**
 * Creating the staging temp directory, copying `DEFAULT_SRC_ROOT` into it, or the withheld-doc
 * strip that follows, failed. `to` is empty when the temp directory itself is what could not be
 * created, since there is no destination to name yet.
 */
export class StageFailed extends Data.TaggedError("STAGE_FAILED")<{
  readonly from: string
  readonly to: string
  readonly detail: string
}> {}

/** The reviewed graph's own vision survived the strip — the mechanical proof, checking this node's own just-performed action rather than a failure nobody has seen. */
export class VisionNotWithheld extends Data.TaggedError("VISION_NOT_WITHHELD")<{
  readonly stagedVisionPath: string
}> {}
