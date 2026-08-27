import { describe, expect, test } from "bun:test"
import type { CloseEvent, OpenEvent, Outcome } from "./event"
import { foldTrace } from "./fold"

const makeOpen = (spanId: string, parentSpanId: string | null, name = spanId): OpenEvent => ({
  kind: "open",
  runId: "run-1",
  spanId,
  parentSpanId,
  name,
  startTimeNanos: "0"
})

const makeClose = (spanId: string, outcome: Outcome = "ok", tag?: string, name = spanId): CloseEvent =>
  tag === undefined
    ? { kind: "close", runId: "run-1", spanId, name, endTimeNanos: "1", durationNanos: "1", outcome }
    : { kind: "close", runId: "run-1", spanId, name, endTimeNanos: "1", durationNanos: "1", outcome, tag }

describe("foldTrace", () => {
  test("a stream with one open and no close: the span is in open, absent from closed", () => {
    const report = foldTrace([makeOpen("a", null)])

    expect(report.open).toEqual([{ spanId: "a", name: "a", parentSpanId: null }])
    expect(report.closed).toEqual([])
  })

  test("a stream with one open and one close: absent from open, in closed with its outcome and tag", () => {
    const report = foldTrace([makeOpen("a", null), makeClose("a", "fail", "BOOM")])

    expect(report.open).toEqual([])
    expect(report.closed).toEqual([{ spanId: "a", name: "a", outcome: "fail", tag: "BOOM" }])
  })

  test("three node runs nested two deep: roots is one entry whose child has one child, named by id", () => {
    const events = [
      makeOpen("root", null),
      makeOpen("mid", "root"),
      makeOpen("leaf", "mid"),
      makeClose("leaf"),
      makeClose("mid"),
      makeClose("root")
    ]

    const report = foldTrace(events)

    expect(report.roots).toEqual([
      {
        spanId: "root",
        children: [
          {
            spanId: "mid",
            children: [{ spanId: "leaf", children: [] }]
          }
        ]
      }
    ])
  })

  // The fold's defining property — reading a stream in one pass and reading it
  // as a part followed by the rest must agree exactly, including a split that falls between one
  // span's open event and that same span's close event (index 3, between "open leaf" and
  // "close leaf"), which is the case that forces resumable state to carry parent links, not just
  // the published open/closed/roots arrays.
  test("incremental identity: foldTrace(rest, foldTrace(part)) deep-equals foldTrace(whole), across several split points including between an open and its matching close", () => {
    const whole = [
      makeOpen("root", null),
      makeOpen("mid", "root"),
      makeOpen("leaf", "mid"),
      makeClose("leaf"),
      makeClose("mid"),
      makeClose("root")
    ]

    const expected = foldTrace(whole)

    for (const splitAt of [1, 3, 5]) {
      const part = whole.slice(0, splitAt)
      const rest = whole.slice(splitAt)

      const incremental = foldTrace(rest, foldTrace(part))

      expect(incremental).toEqual(expected)
    }
  })

  test("a stream truncated mid-run (open, no close, no further events) folds without throwing", () => {
    expect(() => foldTrace([makeOpen("a", null)])).not.toThrow()
  })

  // A stream that starts mid-run — a close event whose open was never seen — is
  // accepted rather than rejected. The contract: the span appears in `closed` (a close event is
  // all that's needed there), never appears in `open` (no open event exists for it), and appears
  // in `roots` as a root of its own (its parent, if any, is unknowable — no parentSpanId ever
  // arrives on a CloseEvent).
  test("a stream that starts mid-run (a close whose open was never seen) is accepted", () => {
    const report = foldTrace([makeClose("orphan", "ok")])

    expect(report.closed).toEqual([{ spanId: "orphan", name: "orphan", outcome: "ok" }])
    expect(report.open).toEqual([])
    expect(report.roots).toEqual([{ spanId: "orphan", children: [] }])
  })

  test("an event whose parentSpanId names a span not present in the stream becomes a root, not a dropped node", () => {
    const report = foldTrace([makeOpen("child", "ghost-parent")])

    // The raw parentSpanId is preserved on the open record — the fold doesn't erase what the
    // event said, it just can't place the span under an ancestor it has never seen.
    expect(report.open).toEqual([{ spanId: "child", name: "child", parentSpanId: "ghost-parent" }])
    expect(report.roots).toEqual([{ spanId: "child", children: [] }])
  })

  test("the empty stream folds to an empty report", () => {
    const report = foldTrace([])

    expect(report.open).toEqual([])
    expect(report.closed).toEqual([])
    expect(report.roots).toEqual([])
  })
})
