import type { Outcome, TraceEvent } from "mag/runtime/trace/event"

/**
 * One node in the parent tree `TraceReport.roots` describes. Spans nest by id
 * only — no name, no outcome — because the tree's one job is "how do the node runs nest", and
 * `TraceReport.open`/`closed` are where a reader looks up what a given `spanId` actually is.
 */
export interface TraceTreeNode {
  readonly spanId: string
  readonly children: ReadonlyArray<TraceTreeNode>
}

/**
 * Everything `foldTrace` knows about one span, and the state a resumed fold needs.
 * `open`/`close` are each present only once their respective event has been seen, independently
 * of one another — a span can be close-only (the stream started mid-run) or open-only (the
 * stream hasn't seen its close yet). "Open" means "has an open event, no close event yet", not
 * "is currently running".
 *
 * `open.parentSpanId` is carried verbatim from the OpenEvent even when it names a span this
 * fold has never seen — the tree-building step is what decides such a span is a root; this
 * record never drops or rewrites what the event actually said.
 */
interface SpanState {
  readonly spanId: string
  readonly name: string
  readonly open: { readonly parentSpanId: string | null } | undefined
  readonly close: { readonly outcome: Outcome; readonly tag?: string } | undefined
}

/**
 * The published fold result. `open`/`closed`/`roots` are the read-only contract
 * `mag/runtime` re-exports. `spans` is not part of that published shape — it is the
 * resumable state `foldTrace` needs to make `foldTrace(rest, foldTrace(part))` agree exactly
 * with `foldTrace([...part, ...rest])`, including the case where `part` ends between one span's
 * open event and its own close event. Without carrying spans (and their parent links) forward,
 * that split would lose the open-side parentSpanId the moment `part`'s report only kept the
 * public arrays.
 */
export interface TraceReport {
  readonly open: ReadonlyArray<{ spanId: string; name: string; parentSpanId: string | null }>
  readonly closed: ReadonlyArray<{ spanId: string; name: string; outcome: Outcome; tag?: string }>
  /**
   * The parent tree, nested by SPAN and not by node run: a node run whose nearest enclosing span is
   * an unmarked one (an `Effect.fn` span, which emits no event) surfaces here as a root, because its
   * `parentSpanId` names a span this fold never saw. See `OpenEvent.parentSpanId` in `event.ts`.
   */
  readonly roots: ReadonlyArray<TraceTreeNode>
  readonly spans: ReadonlyArray<SpanState>
}

/** The fold's starting point, and what an empty stream folds to. */
const EMPTY_REPORT: TraceReport = { open: [], closed: [], roots: [], spans: [] }

/**
 * Apply one event to the accumulated span state, keyed by `spanId` for O(1)
 * lookup/update. Total by construction — every `TraceEvent` is either `"open"` or `"close"` (the
 * tagged union `event.ts` declares), each arm builds a plain record, and neither arm can throw.
 * `Map#set` on an already-known key updates in place without moving it in iteration order (an
 * out-of-order close-then-open, or a normal open-then-close); a new key is appended, matching the
 * array-accumulator behaviour this replaces.
 */
const applyEvent = (spans: Map<string, SpanState>, event: TraceEvent): void => {
  const existing = spans.get(event.spanId)

  const next: SpanState =
    event.kind === "open"
      ? {
          spanId: event.spanId,
          name: event.name,
          open: { parentSpanId: event.parentSpanId },
          close: existing?.close
        }
      : {
          spanId: event.spanId,
          name: event.name,
          open: existing?.open,
          close: event.tag === undefined ? { outcome: event.outcome } : { outcome: event.outcome, tag: event.tag }
        }

  spans.set(event.spanId, next)
}

/**
 * Build the parent tree over every span seen so far, regardless of whether each
 * one is open or closed. A span is a root when it has no open event (a close-only span never
 * carries a parentSpanId at all — CloseEvent has no such field), when its own open event named
 * `parentSpanId: null`, or when its open event names a `parentSpanId` this fold has never seen —
 * "becomes a root, not a dropped node" is the contract for that last case. The `seen` guard in
 * `buildNode` is defensive: it stops a cyclic parent chain from recursing forever, keeping the
 * fold total even against event data that shouldn't occur in practice.
 */
const buildRoots = (spans: ReadonlyArray<SpanState>): ReadonlyArray<TraceTreeNode> => {
  const known = new Set(spans.map((span) => span.spanId))
  const childrenOf = new Map<string, Array<string>>()
  const rootIds: Array<string> = []

  for (const span of spans) {
    const parentId = span.open?.parentSpanId
    if (parentId !== null && parentId !== undefined && known.has(parentId)) {
      const siblings = childrenOf.get(parentId)
      if (siblings === undefined) childrenOf.set(parentId, [span.spanId])
      else siblings.push(span.spanId)
    } else {
      rootIds.push(span.spanId)
    }
  }

  const buildNode = (spanId: string, seen: ReadonlySet<string>): TraceTreeNode => {
    if (seen.has(spanId)) return { spanId, children: [] }
    const nextSeen = new Set(seen)
    nextSeen.add(spanId)
    const childIds = childrenOf.get(spanId) ?? []
    return { spanId, children: childIds.map((childId) => buildNode(childId, nextSeen)) }
  }

  return rootIds.map((spanId) => buildNode(spanId, new Set()))
}

/**
 * Project the accumulated span state onto the published report. `open` is every
 * span with an open event and no close event yet (never "is currently running"); `closed` is every span with a close event,
 * regardless of whether its open event was ever seen.
 */
const project = (spans: ReadonlyArray<SpanState>): TraceReport => {
  const open = spans.flatMap((span) =>
    span.open !== undefined && span.close === undefined
      ? [{ spanId: span.spanId, name: span.name, parentSpanId: span.open.parentSpanId }]
      : []
  )

  const closed = spans.flatMap((span) => {
    if (span.close === undefined) return []
    return span.close.tag === undefined
      ? [{ spanId: span.spanId, name: span.name, outcome: span.close.outcome }]
      : [{ spanId: span.spanId, name: span.name, outcome: span.close.outcome, tag: span.close.tag }]
  })

  return { open, closed, roots: buildRoots(spans), spans }
}

/**
 * A pure, total reduce from a (partial) event stream to what that stream says.
 * Passing a `previous` report back in resumes from its carried span state, which is what makes
 * `foldTrace(rest, foldTrace(part))` deep-equal `foldTrace([...part, ...rest])` for any split
 * point of the same stream — including a split that falls between one span's open event and its
 * own close event. No input shape causes a throw: an unmatched close, a truncated open, an
 * unknown parent, and the empty stream are all valid partial views — any part of an event stream,
 * from a finished CLI invocation or from a running one, folds without error.
 */
export const foldTrace = (events: Iterable<TraceEvent>, previous: TraceReport = EMPTY_REPORT): TraceReport => {
  const spans = new Map(previous.spans.map((span): [string, SpanState] => [span.spanId, span]))
  for (const event of events) {
    applyEvent(spans, event)
  }
  return project([...spans.values()])
}
