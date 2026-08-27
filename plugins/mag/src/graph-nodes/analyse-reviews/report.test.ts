import { describe, expect, test } from "bun:test"
import { missingAttributions, renderReport } from "mag/graph-nodes/analyse-reviews/report"

const WINDOW = { size: 5, since: "2026-08-20T00:00:00.000Z", through: "2026-08-20T21:16:11.402Z" }

describe("renderReport", () => {
  test("the first line is the watermark the next window will read", () => {
    const report = renderReport(WINDOW, { sendBacks: [], patterns: [], note: "" })
    expect(report.split("\n")[0]).toBe(`Analysed through ${WINDOW.through}`)
  })

  test("every send-back and pattern renders with its evidence and fix", () => {
    const report = renderReport(WINDOW, {
      sendBacks: [
        { id: "GH-203/run-1#2", attribution: "build-loose", evidence: "cited from build-2.md", fix: "tighten the test" }
      ],
      patterns: [
        { pattern: "loose test asserts nothing", attribution: "build-loose", occurrences: ["a", "b"], fix: "add a real assertion" }
      ],
      note: ""
    })
    expect(report).toContain("- GH-203/run-1#2: build-loose")
    expect(report).toContain("  evidence: cited from build-2.md")
    expect(report).toContain("  fix: tighten the test")
    expect(report).toContain("### loose test asserts nothing (build-loose, 2 occurrences: a, b)")
    expect(report).toContain("add a real assertion")
  })

  test("a window of all-clean passes still gets a report", () => {
    const report = renderReport(WINDOW, { sendBacks: [], patterns: [], note: "" })
    expect(report).toContain("None — every pass in this window was clean.")
    expect(report).toContain("None.")
  })

  test("a non-empty note appends its own section", () => {
    const report = renderReport(WINDOW, { sendBacks: [], patterns: [], note: "worth flagging separately" })
    expect(report).toContain("## Note\nworth flagging separately")
  })
})

describe("missingAttributions", () => {
  test("every required id answered leaves nothing missing", () => {
    expect(missingAttributions(["a", "b"], ["a", "b"])).toStrictEqual([])
  })

  test("a shortfall names exactly the ids left unanswered", () => {
    expect(missingAttributions(["a", "b", "c"], ["b"])).toStrictEqual(["a", "c"])
  })
})
