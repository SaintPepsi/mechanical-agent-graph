import { describe, expect, test } from "bun:test"
import type { CloseEvent, OpenEvent } from "./event"
import { formatEventLine, formatSeconds } from "./console-sink"
import { UNTAGGED_FAILURE } from "./outcome"

const openEvent: OpenEvent = {
  kind: "open",
  runId: "run-1",
  spanId: "span-1",
  parentSpanId: null,
  name: "echo",
  startTimeNanos: "0"
}

const closeEvent = (overrides: Partial<CloseEvent>): CloseEvent => ({
  kind: "close",
  runId: "run-1",
  spanId: "span-1",
  name: "echo",
  endTimeNanos: "1000000000",
  durationNanos: "1000000000",
  outcome: "ok",
  ...overrides
})

describe("formatEventLine", () => {
  test("an open event for node echo reads 'mag: [echo] entered'", () => {
    expect(formatEventLine(openEvent)).toBe("mag: [echo] entered")
  })

  test("a close event, outcome ok, duration 1.2s reads 'mag: [echo] ok 1.2s'", () => {
    const event = closeEvent({ outcome: "ok", durationNanos: "1200000000" })

    expect(formatEventLine(event)).toBe("mag: [echo] ok 1.2s")
  })

  test("a close event, outcome fail, tag BOOM, duration 0.3s reads 'mag: [echo] FAIL BOOM 0.3s'", () => {
    const event = closeEvent({ outcome: "fail", tag: "BOOM", durationNanos: "300000000" })

    expect(formatEventLine(event)).toBe("mag: [echo] FAIL BOOM 0.3s")
  })

  /** The `<WORD> <Tag> <seconds>` shape defined for `ok` and `fail` extends the same way to
   * `die` (a defect, same tag mechanics as `fail`), rendered as `DIE` to keep the outcome word
   * visually distinct from `FAIL`. */
  test("a close event, outcome die, tag SOME_TAG, duration 0.3s reads 'mag: [echo] DIE SOME_TAG 0.3s'", () => {
    const event = closeEvent({ outcome: "die", tag: "SOME_TAG", durationNanos: "300000000" })

    expect(formatEventLine(event)).toBe("mag: [echo] DIE SOME_TAG 0.3s")
  })

  /** `interrupt` carries no tag (see outcome.ts's `outcomeOf`), so its
   * line drops the tag segment entirely rather than printing a fallback tag for a case that
   * was never a failure. */
  test("a close event, outcome interrupt, duration 0.3s reads 'mag: [echo] INTERRUPT 0.3s'", () => {
    const event = closeEvent({ outcome: "interrupt", durationNanos: "300000000" })

    expect(formatEventLine(event)).toBe("mag: [echo] INTERRUPT 0.3s")
  })

  test("a fail close event with no tag names UNKNOWN_ERROR (via UNTAGGED_FAILURE, not hand-spelled)", () => {
    const event = closeEvent({ outcome: "fail", durationNanos: "300000000" })

    expect(formatEventLine(event)).toBe(`mag: [echo] FAIL ${UNTAGGED_FAILURE} 0.3s`)
  })

  test("every produced line starts with the fixed prefix 'mag:'", () => {
    const lines = [
      formatEventLine(openEvent),
      formatEventLine(closeEvent({ outcome: "ok", durationNanos: "1200000000" })),
      formatEventLine(closeEvent({ outcome: "fail", tag: "BOOM", durationNanos: "300000000" })),
      formatEventLine(closeEvent({ outcome: "die", tag: "SOME_TAG", durationNanos: "300000000" })),
      formatEventLine(closeEvent({ outcome: "interrupt", durationNanos: "300000000" }))
    ]

    for (const line of lines) {
      expect(line.startsWith("mag:")).toBe(true)
    }
  })
})

describe("formatSeconds", () => {
  test("1_200_000_000 nanos → '1.2s'", () => {
    expect(formatSeconds("1200000000")).toBe("1.2s")
  })

  test("300000000 nanos → '0.3s'", () => {
    expect(formatSeconds("300000000")).toBe("0.3s")
  })

  test("0 nanos → '0.0s'", () => {
    expect(formatSeconds("0")).toBe("0.0s")
  })

  test("a duration over a minute still renders as seconds with one decimal, not a minutes format", () => {
    expect(formatSeconds("90000000000")).toBe("90.0s")
  })
})
