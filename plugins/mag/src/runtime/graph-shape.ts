import { Schema } from "effect"

/**
 * A construct already holds every stage as data (`Step`, `construct.ts`) and publishes it per
 * finalised node through the module-private `BLUEPRINTS` table. Nothing turns that into a
 * picture a viewer can draw without running the graph — this is that picture: a plain, versioned,
 * serialisable projection of a construct's elements and edges, carrying no closure, no position and
 * no reference to any UI library. Runtime-owned rather than living beside a consumer because it is
 * read by the fold in `construct.ts`, by the published barrel, and by every future dependent —
 * `review-window.ts`'s own "used by two or more files" threshold for Central Type Ownership.
 *
 * The runtime never reads this back: `.finalise`'s return stays exactly `graph()`'s own value
 * (see `construct.ts`'s `BLUEPRINTS` doc comment). This module is data only, no logic — the fold
 * that produces a `GraphShape` lives beside the table it reads, in `construct.ts`.
 *
 * The names `Shape`/`readShape` are already taken in `runtime/` by the mermaid-vision grammar
 * (`vision-shape.ts`), an unrelated concept: this module and its type are named for the graph it
 * projects, not for the bare word.
 */

/** Group and loop are containers a viewer draws a box around; every other kind is a leaf. */
export const ELEMENT_KINDS = ["group", "node", "decision", "fork", "loop"] as const
export type ElementKind = (typeof ELEMENT_KINDS)[number]

export const ShapeElementSchema = Schema.Struct({
  kind: Schema.Literals(ELEMENT_KINDS),
  /** A derived path, e.g. `develop-graph/3:group:publish-tail/0:fork` — opaque, never re-parsed. */
  id: Schema.String,
  label: Schema.String,
  /** The enclosing container's id: which box this element is drawn in. `null` on the root group only. */
  parent: Schema.NullOr(Schema.String)
})
export type ShapeElement = typeof ShapeElementSchema.Type

const EdgeEnds = { from: Schema.String, to: Schema.String }

export const SequenceEdgeSchema = Schema.Struct({ kind: Schema.tag("sequence"), ...EdgeEnds })
export const BranchEdgeSchema = Schema.Struct({ kind: Schema.tag("branch"), ...EdgeEnds, label: Schema.String })
/** One declared read of a decision: `from` is the element of the single stage that produced the
 *  field, `to` the decision that declared it, and `field` its name. A field no stage above the
 *  decision produced comes from the seed, so its `from` is the enclosing container's own group. */
export const DataEdgeSchema = Schema.Struct({ kind: Schema.tag("data"), ...EdgeEnds, field: Schema.String })

export const ShapeEdgeSchema = Schema.Union([SequenceEdgeSchema, BranchEdgeSchema, DataEdgeSchema]).pipe(
  Schema.toTaggedUnion("kind")
)
export type ShapeEdge = typeof ShapeEdgeSchema.Type

/** `mag/`, not the `graph/` prefix `JOURNAL_SCHEMA` and `REVIEW_WINDOW_SCHEMA` carry: those two
 *  have records already written to disk that a reader must keep decoding, so their ids are frozen.
 *  Nothing writes a shape yet, so this one starts on the package's own name. */
export const SHAPE_SCHEMA = "mag/shape@1" as const

export const GraphShapeSchema = Schema.Struct({
  schema: Schema.Literal(SHAPE_SCHEMA),
  /** The root group's id, so no consumer has to search for the element with a null parent. */
  root: Schema.String,
  elements: Schema.Array(ShapeElementSchema),
  edges: Schema.Array(ShapeEdgeSchema)
})
export type GraphShape = typeof GraphShapeSchema.Type
