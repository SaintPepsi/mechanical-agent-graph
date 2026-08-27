/**
 * The published contract. `mag/runtime` resolves here via the package's
 * `exports` map (`"./*": "./src/*.ts"`), and that exact specifier is already allowlisted for
 * every node (`mag/runtime/graph-node.shape.ts`'s `ALLOW_RULES`, the
 * `mag/runtime`/`mag/runtime/*` row) — which is why no node file needs a new
 * allowlist entry to import from here. A barrel only: re-exports, no logic, no new type, no
 * renaming. Deliberately excludes `tracerLayer`/`tracingLayer`/`RunId`/`runIdLayer`
 * (`mag/runtime/trace/layer`) — those are entry-composition wiring, not the viewer-facing
 * contract this module publishes.
 */
export { type CloseEvent, type OpenEvent, type Outcome, type TraceEvent, TraceEventSchema } from "mag/runtime/trace/event"
export { foldTrace, type TraceReport } from "mag/runtime/trace/fold"
export { type TraceSink } from "mag/runtime/trace/sink"
export { consoleSinkLayer } from "mag/runtime/trace/console-sink"
export { fileSinkLayer } from "mag/runtime/trace/file-sink"

// The graph shape, the viewer's contract (`docs/requirements/graph-visualiser.md`, FR-1).
export {
  type ElementKind,
  ELEMENT_KINDS,
  type GraphShape,
  GraphShapeSchema,
  SHAPE_SCHEMA,
  type ShapeEdge,
  ShapeEdgeSchema,
  type ShapeElement,
  ShapeElementSchema
} from "mag/runtime/graph-shape"
