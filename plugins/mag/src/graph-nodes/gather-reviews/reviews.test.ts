import { describe, expect, test } from "bun:test"
import {
  buildManifest,
  indexArtifacts,
  reviewDiffFilenamesInOrder,
  reviewPasses,
  selectWindow,
  shaFromFindingsFirstLine,
  watermarkFrom
} from "mag/graph-nodes/gather-reviews/reviews"
import type { JournalEndRow, JournalStartRow } from "mag/runtime/journal/row"
import type { ReviewPass } from "mag/runtime/review-window"
import { testJournalStamp } from "mag/test/node-fixture"

/**
 * Testing strategy: the pure core, exercised with literal journal rows rather than real
 * files — `reviewPasses`/`selectWindow`/`indexArtifacts`/`buildManifest`/`watermarkFrom` all take
 * plain data and return plain data.
 */

const STAMP = testJournalStamp({ ticket: "GH-197", sha: "aaa" })
const { graph } = STAMP

const start = (node: string, attempt: number, timestamp: string): JournalStartRow => ({
  schema: "graph/journal@3",
  ...STAMP,
  node,
  attempt,
  event: "start",
  timestamp
})

const end = (
  node: string,
  attempt: number,
  timestamp: string,
  rest: {
    readonly outcome: "ok" | "fail" | "die" | "interrupt"
    readonly tag?: string
    readonly input?: unknown
    readonly success?: unknown
  }
): JournalEndRow => ({
  schema: "graph/journal@3",
  ...STAMP,
  node,
  attempt,
  event: "end",
  timestamp,
  replayed: false,
  ...rest
})

/** A clean review-diff pass, at a given attempt and timestamp pair, gating `headSha`. */
const cleanReviewRows = (attempt: number, headSha: string, startedAt: string, endedAt: string) => [
  start("review-diff", attempt, startedAt),
  end("review-diff", attempt, endedAt, {
    outcome: "ok",
    input: { headSha },
    success: { findingsPath: "unused", headSha, sessions: [`s${attempt}`], costUsd: 0.1 }
  })
]

/** A send-back: outcome fail, tag REVIEW_BLOCKED, no success — review-diff journals a blocked pass this way. */
const blockedReviewRows = (attempt: number, headSha: string, startedAt: string, endedAt: string) => [
  start("review-diff", attempt, startedAt),
  end("review-diff", attempt, endedAt, { outcome: "fail", tag: "REVIEW_BLOCKED", input: { headSha } })
]

describe("reviewPasses", () => {
  test("a clean pass carries its headSha, timestamps and sessions", () => {
    const rows = cleanReviewRows(1, "sha1", "2026-08-20T00:00:00.000Z", "2026-08-20T00:05:00.000Z")
    const passes = reviewPasses({ projectKey: "proj", runRoot: "/root/run-1", rows })
    expect(passes).toStrictEqual([
      {
        id: "GH-197/run-1#1",
        projectKey: "proj",
        ticket: "GH-197",
        graph,
        runId: "run-1",
        runRoot: "/root/run-1",
        pass: 1,
        verdict: "clean",
        headSha: "sha1",
        startedAt: "2026-08-20T00:00:00.000Z",
        endedAt: "2026-08-20T00:05:00.000Z",
        findingsPath: null,
        buildSummaryPath: null,
        designPath: null,
        disputePath: null,
        sessions: ["s1"]
      }
    ])
  })

  test("a blocked pass is counted with an empty sessions list — the journal never records one for a blocked verdict", () => {
    const rows = blockedReviewRows(1, "sha1", "2026-08-20T00:00:00.000Z", "2026-08-20T00:05:00.000Z")
    const passes = reviewPasses({ projectKey: "proj", runRoot: "/root/run-1", rows })
    expect(passes).toHaveLength(1)
    expect(passes[0]).toMatchObject({ verdict: "blocked", tag: "REVIEW_BLOCKED", sessions: [] })
  })

  test("REVIEW_DISPUTE_REJECTED is dispute-rejected, and carries the disputePath its input named", () => {
    const rows = [
      start("review-diff", 3, "t0"),
      end("review-diff", 3, "t1", {
        outcome: "fail",
        tag: "REVIEW_DISPUTE_REJECTED",
        input: { headSha: "sha3", disputePath: "/root/run-1/dispute-1.md" }
      })
    ]
    const passes = reviewPasses({ projectKey: "proj", runRoot: "/root/run-1", rows })
    expect(passes[0]).toMatchObject({ verdict: "dispute-rejected", disputePath: "/root/run-1/dispute-1.md" })
  })

  test("REVIEW_HEAD_MOVED (and any other outcome/tag pair) is neither counted nor listed", () => {
    const rows = [
      start("review-diff", 1, "t0"),
      end("review-diff", 1, "t1", { outcome: "fail", tag: "REVIEW_HEAD_MOVED", input: { headSha: "sha1" } })
    ]
    expect(reviewPasses({ projectKey: "proj", runRoot: "/root/run-1", rows })).toStrictEqual([])
  })

  test("a review row with no recorded headSha answers nothing this schema needs, and is dropped", () => {
    const rows = [start("review-diff", 1, "t0"), end("review-diff", 1, "t1", { outcome: "ok", input: {} })]
    expect(reviewPasses({ projectKey: "proj", runRoot: "/root/run-1", rows })).toStrictEqual([])
  })

  test("buildSummaryPath comes from this run's own build success row sharing the review's headSha", () => {
    const rows = [
      start("build", 1, "b0"),
      end("build", 1, "b1", { outcome: "ok", success: { headSha: "sha1", summaryPath: "/root/run-1/build-1.md" } }),
      ...cleanReviewRows(1, "sha1", "t0", "t1")
    ]
    const passes = reviewPasses({ projectKey: "proj", runRoot: "/root/run-1", rows })
    expect(passes[0]!.buildSummaryPath).toBe("/root/run-1/build-1.md")
  })

  test("a review row whose build row is absent (a disputed pass) leaves buildSummaryPath null rather than guessing", () => {
    const passes = reviewPasses({
      projectKey: "proj",
      runRoot: "/root/run-1",
      rows: cleanReviewRows(1, "sha1", "t0", "t1")
    })
    expect(passes[0]!.buildSummaryPath).toBeNull()
  })

  test("designPath comes from the run's own design end row, when it ran one", () => {
    const rows = [
      start("design", 1, "d0"),
      end("design", 1, "d1", { outcome: "ok", success: { designPath: "docs/graph/GH-197/design.md" } }),
      ...cleanReviewRows(1, "sha1", "t0", "t1")
    ]
    const passes = reviewPasses({ projectKey: "proj", runRoot: "/root/run-1", rows })
    expect(passes[0]!.designPath).toBe("docs/graph/GH-197/design.md")
  })
})

describe("selectWindow", () => {
  const pass = (id: string, endedAt: string): ReviewPass => ({
    id,
    projectKey: "proj",
    ticket: "GH-197",
    graph,
    runId: "run-1",
    runRoot: "/root/run-1",
    pass: 1,
    verdict: "clean",
    headSha: "sha",
    startedAt: endedAt,
    endedAt,
    findingsPath: null,
    buildSummaryPath: null,
    designPath: null,
    disputePath: null,
    sessions: []
  })

  test("a window short by one is undefined, not a partial selection", () => {
    const passes = [1, 2, 3, 4].map((n) => pass(`p${n}`, `2026-08-20T00:0${n}:00.000Z`))
    expect(selectWindow(passes, "2026-08-19T00:00:00.000Z", 5)).toBeUndefined()
  })

  test("six passes yield the oldest five, the sixth left untouched for the next window", () => {
    const passes = [1, 2, 3, 4, 5, 6].map((n) => pass(`p${n}`, `2026-08-20T00:0${n}:00.000Z`))
    const window = selectWindow(passes, "2026-08-19T00:00:00.000Z", 5)
    expect(window?.selected.map((p) => p.id)).toStrictEqual(["p1", "p2", "p3", "p4", "p5"])
    expect(window?.through).toBe("2026-08-20T00:05:00.000Z")
  })

  test("a watermark excludes everything at or before it", () => {
    const passes = [1, 2, 3, 4, 5].map((n) => pass(`p${n}`, `2026-08-20T00:0${n}:00.000Z`))
    expect(selectWindow(passes, "2026-08-20T00:03:00.000Z", 2)?.selected.map((p) => p.id)).toStrictEqual(["p4", "p5"])
  })
})

describe("indexArtifacts", () => {
  test("matches by sha, not position — a dropped pass never shifts a later filename out of step", () => {
    const passes = [{ id: "a", headSha: "sha-a" }, { id: "b", headSha: "sha-b" }]
    const artifacts = [{ path: "review-diff-1.md", sha: "sha-b" }, { path: "review-diff-2.md", sha: "sha-a" }]
    const found = indexArtifacts(passes, artifacts)
    expect(found.get("a")).toBe("review-diff-2.md")
    expect(found.get("b")).toBe("review-diff-1.md")
  })

  test("two passes sharing a headSha (an adjudicating dispute) resolve FIFO, by journal order", () => {
    const passes = [{ id: "first", headSha: "sha-x" }, { id: "second", headSha: "sha-x" }]
    const artifacts = [{ path: "review-diff-1.md", sha: "sha-x" }, { path: "review-diff-2.md", sha: "sha-x" }]
    const found = indexArtifacts(passes, artifacts)
    expect(found.get("first")).toBe("review-diff-1.md")
    expect(found.get("second")).toBe("review-diff-2.md")
  })

  test("a pass with no matching artifact is simply absent from the map", () => {
    expect(indexArtifacts([{ id: "a", headSha: "sha-a" }], []).has("a")).toBe(false)
  })
})

describe("reviewDiffFilenamesInOrder", () => {
  test("sorts numerically, not lexically, and drops anything that isn't a review-diff artifact", () => {
    const names = ["review-diff-10.md", "review-diff-2.md", "build-1.md", "review-diff-1.md"]
    expect(reviewDiffFilenamesInOrder(names)).toStrictEqual(["review-diff-1.md", "review-diff-2.md", "review-diff-10.md"])
  })
})

describe("shaFromFindingsFirstLine", () => {
  test("reads the 'Reviewed at <sha>' line", () => {
    expect(shaFromFindingsFirstLine("Reviewed at abc123")).toBe("abc123")
  })

  test("anything else answers undefined", () => {
    expect(shaFromFindingsFirstLine("No blocking findings.")).toBeUndefined()
  })
})

describe("watermarkFrom", () => {
  test("the maximum 'Analysed through <ISO>' across every prior report", () => {
    const lines = ["Analysed through 2026-08-20T10:00:00.000Z", "Analysed through 2026-08-20T21:16:11.402Z"]
    expect(watermarkFrom(lines, "2026-08-01T00:00:00.000Z")).toBe("2026-08-20T21:16:11.402Z")
  })

  test("no prior reports falls back to epoch", () => {
    expect(watermarkFrom([], "2026-08-20T00:00:00.000Z")).toBe("2026-08-20T00:00:00.000Z")
  })

  test("a line that doesn't parse is ignored, not fatal", () => {
    expect(watermarkFrom(["garbage"], "2026-08-20T00:00:00.000Z")).toBe("2026-08-20T00:00:00.000Z")
  })
})

describe("buildManifest", () => {
  test("stamps the schema literal and passes every field through unchanged", () => {
    const manifest = buildManifest({
      size: 5,
      since: "2026-08-20T00:00:00.000Z",
      through: "2026-08-20T21:16:11.402Z",
      transcriptsRoot: "/home/dev/.claude/projects",
      passes: []
    })
    expect(manifest).toStrictEqual({
      schema: "graph/review-window@1",
      size: 5,
      since: "2026-08-20T00:00:00.000Z",
      through: "2026-08-20T21:16:11.402Z",
      transcriptsRoot: "/home/dev/.claude/projects",
      passes: []
    })
  })
})
