import { describe, expect, test } from "bun:test"
import type { CloseEvent, ElementKind, GraphShape, OpenEvent, Outcome, ShapeEdge, ShapeElement, TraceEvent, TraceReport, TraceSink } from "mag/runtime"
import { ELEMENT_KINDS, GraphShapeSchema, SHAPE_SCHEMA, ShapeEdgeSchema, ShapeElementSchema, TraceEventSchema, consoleSinkLayer, fileSinkLayer, foldTrace } from "mag/runtime"
import { foldTrace as directFoldTrace } from "mag/runtime/trace/fold"

/**
 * `mag/runtime` is the published contract — a future viewer builds against
 * this specifier only, never a relative path into `src/runtime/trace/`. Every assertion below
 * therefore imports from `"mag/runtime"`, the package-exports specifier, not `"../src/runtime"`.
 */

describe("mag/runtime published barrel", () => {
  test("foldTrace is importable from mag/runtime and callable", () => {
    expect(typeof foldTrace).toBe("function")
    expect(foldTrace([])).toEqual({ open: [], closed: [], roots: [], spans: [] })
  })

  test("TraceEventSchema, consoleSinkLayer, fileSinkLayer are importable from mag/runtime and are values", () => {
    expect(TraceEventSchema).toBeDefined()
    expect(consoleSinkLayer).toBeDefined()
    expect(typeof fileSinkLayer).toBe("function")
    expect(fileSinkLayer("/tmp/does-not-matter.ndjson")).toBeDefined()
  })

  // The graph shape joins the published contract — schema, kind table and version literal
  // all importable from mag/runtime, not only from runtime/graph-shape.ts directly.
  test("GraphShapeSchema, ShapeElementSchema, ShapeEdgeSchema, ELEMENT_KINDS, SHAPE_SCHEMA are importable from mag/runtime and are values", () => {
    expect(GraphShapeSchema).toBeDefined()
    expect(ShapeElementSchema).toBeDefined()
    expect(ShapeEdgeSchema).toBeDefined()
    expect(ELEMENT_KINDS).toEqual(["group", "node", "decision", "fork", "loop"])
    expect(SHAPE_SCHEMA).toBe("mag/shape@1")
  })

  // Type-only usage — proves TraceEvent, Outcome, TraceReport, OpenEvent, CloseEvent, and
  // TraceSink are all importable as types from mag/runtime. Checked by `bun run typecheck`,
  // not a runtime assertion: these functions are never called.
  const acceptsTraceEvent = (_event: TraceEvent): void => {}
  const acceptsOutcome = (_outcome: Outcome): void => {}
  const acceptsTraceReport = (_report: TraceReport): void => {}
  const acceptsOpenEvent = (_event: OpenEvent): void => {}
  const acceptsCloseEvent = (_event: CloseEvent): void => {}
  const acceptsTraceSink = (_sink: TraceSink): void => {}
  // Same proof for GraphShape, ShapeElement, ShapeEdge, ElementKind.
  const acceptsGraphShape = (_shape: GraphShape): void => {}
  const acceptsShapeElement = (_element: ShapeElement): void => {}
  const acceptsShapeEdge = (_edge: ShapeEdge): void => {}
  const acceptsElementKind = (_kind: ElementKind): void => {}
  void acceptsTraceEvent
  void acceptsOutcome
  void acceptsTraceReport
  void acceptsOpenEvent
  void acceptsCloseEvent
  void acceptsTraceSink
  void acceptsGraphShape
  void acceptsShapeElement
  void acceptsShapeEdge
  void acceptsElementKind

  // A smoke fold through the barrel — the barrel's re-exported foldTrace and
  // fold.ts's own directly-imported foldTrace must be the SAME function reference, and must agree
  // on the same input. This is what "one definition, two paths to it" means: not two
  // implementations that happen to produce equal output, but one implementation reached two ways.
  test("foldTrace via the barrel is the same function as fold.ts's own foldTrace, and agrees on a hand-built event stream", () => {
    expect(foldTrace).toBe(directFoldTrace)

    const openEvent: OpenEvent = {
      kind: "open",
      runId: "run-1",
      spanId: "a",
      parentSpanId: null,
      name: "a",
      startTimeNanos: "0"
    }
    const closeEvent: CloseEvent = {
      kind: "close",
      runId: "run-1",
      spanId: "a",
      name: "a",
      endTimeNanos: "1",
      durationNanos: "1",
      outcome: "ok"
    }
    const events = [openEvent, closeEvent]

    const viaBarrel = foldTrace(events)
    const viaDirect = directFoldTrace(events)

    expect(viaBarrel).toEqual(viaDirect)
    expect(viaBarrel.closed).toEqual([{ spanId: "a", name: "a", outcome: "ok" }])
  })
})
