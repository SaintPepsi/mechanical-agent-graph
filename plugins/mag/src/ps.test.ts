import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { decodeJournalLines, presentRows, processAlive, renderTable, STALE_THRESHOLD_MS, summarizeJournal } from "mag/ps"
import { JournalRowSchema } from "mag/runtime/journal/row"

/**
 * Fixture journal rows, not live runs — the parsing/active-detection logic is pure and
 * testable against fixture lines without touching the real journal root (the scan-the-real-filesystem
 * half, `scanRoot`/`rowForJournal`, stays unverified here).
 */

const decode = Schema.decodeUnknownSync(JournalRowSchema)

const STAMP = {
  schema: "graph/journal@3" as const,
  runId: "run-1",
  ticket: "GH-192",
  graph: "develop-graph",
  repoRoot: "/repo",
  sha: "abc1234",
  pipelineSha: "def4567"
}

const startRow = (over: Record<string, unknown> = {}) =>
  decode({ ...STAMP, node: "build", attempt: 1, event: "start", timestamp: "2026-08-20T12:00:00.000Z", ...over })

const endRow = (over: Record<string, unknown> = {}) =>
  decode({
    ...STAMP,
    node: "build",
    attempt: 1,
    event: "end",
    timestamp: "2026-08-20T12:01:00.000Z",
    replayed: false,
    outcome: "ok",
    ...over
  })

describe("decodeJournalLines", () => {
  test("decodes every well-formed line and skips blank and malformed ones", () => {
    const text = [
      JSON.stringify(startRow()),
      "",
      "not json at all",
      JSON.stringify({ foo: "not a journal row" }),
      JSON.stringify(endRow())
    ].join("\n")

    const rows = decodeJournalLines(text)

    expect(rows.map((r) => r.event)).toEqual(["start", "end"])
  })

  test("a truncated final line (a run killed mid-append) is skipped, not fatal", () => {
    const text = `${JSON.stringify(startRow())}\n${JSON.stringify(startRow({ node: "verification" })).slice(0, 20)}`

    const rows = decodeJournalLines(text)

    expect(rows).toHaveLength(1)
  })
})

describe("summarizeJournal — active vs finished", () => {
  const NOW = Date.parse("2026-08-20T12:05:00.000Z")
  const FRESH_MTIME = Date.parse("2026-08-20T12:04:50.000Z")

  test("no rows at all: nothing to report", () => {
    expect(Option.isNone(summarizeJournal([], "proj-abc", FRESH_MTIME, NOW))).toBe(true)
  })

  test("every start matched by its end — the run finished, and is excluded", () => {
    const rows = [startRow(), endRow()]
    expect(Option.isNone(summarizeJournal(rows, "proj-abc", FRESH_MTIME, NOW))).toBe(true)
  })

  test("a fork's interleaving — an end row lands last while the other side is still open — stays active", () => {
    const rows = [
      startRow({ node: "envision-visions", attempt: 1, timestamp: "2026-08-20T12:00:00.000Z" }),
      startRow({ node: "discover", attempt: 1, timestamp: "2026-08-20T12:00:01.000Z" }),
      endRow({ node: "discover", attempt: 1, timestamp: "2026-08-20T12:01:00.000Z" })
    ]
    const row = summarizeJournal(rows, "proj-abc", FRESH_MTIME, NOW).pipe(Option.getOrThrow)
    expect(row.node).toBe("envision-visions")
    expect(row.attempt).toBe(1)
  })

  test("last row is a start — active, named by the last row's own stamped fields", () => {
    const rows = [startRow()]
    const result = summarizeJournal(rows, "proj-abc", FRESH_MTIME, NOW)

    expect(Option.isSome(result)).toBe(true)
    const row = result.pipe(Option.getOrThrow)
    expect(row.projectKey).toBe("proj-abc")
    expect(row.ticket).toBe("GH-192")
    expect(row.graph).toBe("develop-graph")
    expect(row.runId).toBe("run-1")
    expect(row.node).toBe("build")
    expect(row.attempt).toBe(1)
    // Single-row journal: the run's start IS the current node's start.
    expect(row.nodeElapsedMs).toBe(NOW - Date.parse("2026-08-20T12:00:00.000Z"))
    expect(row.runElapsedMs).toBe(row.nodeElapsedMs)
  })

  test("a second node's start after the first completed: current node and run start diverge", () => {
    const rows = [
      startRow({ node: "design", attempt: 1, timestamp: "2026-08-20T12:00:00.000Z" }),
      endRow({ node: "design", attempt: 1, timestamp: "2026-08-20T12:01:00.000Z" }),
      startRow({ node: "build", attempt: 2, timestamp: "2026-08-20T12:02:00.000Z" })
    ]

    const row = summarizeJournal(rows, "proj-abc", FRESH_MTIME, NOW).pipe(Option.getOrThrow)

    expect(row.node).toBe("build")
    expect(row.attempt).toBe(2)
    expect(row.nodeElapsedMs).toBe(NOW - Date.parse("2026-08-20T12:02:00.000Z"))
    expect(row.runElapsedMs).toBe(NOW - Date.parse("2026-08-20T12:00:00.000Z"))
  })
})

describe("summarizeJournal — $ (est.) cost sum", () => {
  const NOW = Date.parse("2026-08-20T12:05:00.000Z")
  const FRESH_MTIME = Date.parse("2026-08-20T12:04:50.000Z")

  test("no end rows yet — a floor of zero, not a fabrication", () => {
    const row = summarizeJournal([startRow()], "proj-abc", FRESH_MTIME, NOW).pipe(Option.getOrThrow)
    expect(row.costUsd).toBe(0)
  })

  test("an end row whose success carries no cost field contributes zero", () => {
    const rows = [
      startRow({ node: "design", attempt: 1, timestamp: "2026-08-20T12:00:00.000Z" }),
      endRow({ node: "design", attempt: 1, timestamp: "2026-08-20T12:01:00.000Z", success: { commits: 1 } }),
      startRow({ node: "build", attempt: 1, timestamp: "2026-08-20T12:02:00.000Z" })
    ]
    const row = summarizeJournal(rows, "proj-abc", FRESH_MTIME, NOW).pipe(Option.getOrThrow)
    expect(row.costUsd).toBe(0)
  })

  test("a null costUsd (the agent-bearing schema's no-cost shape) contributes zero", () => {
    const rows = [
      startRow({ node: "design", attempt: 1, timestamp: "2026-08-20T12:00:00.000Z" }),
      endRow({
        node: "design",
        attempt: 1,
        timestamp: "2026-08-20T12:01:00.000Z",
        success: { costUsd: null, sessions: ["a1b2c3"] }
      }),
      startRow({ node: "build", attempt: 1, timestamp: "2026-08-20T12:02:00.000Z" })
    ]
    const row = summarizeJournal(rows, "proj-abc", FRESH_MTIME, NOW).pipe(Option.getOrThrow)
    expect(row.costUsd).toBe(0)
  })

  test("sums cost across every end row in the journal, not just the in-flight node's start", () => {
    const rows = [
      startRow({ node: "design", attempt: 1, timestamp: "2026-08-20T12:00:00.000Z" }),
      endRow({
        node: "design",
        attempt: 1,
        timestamp: "2026-08-20T12:01:00.000Z",
        success: { costUsd: 0.31, sessions: ["a1"] }
      }),
      startRow({ node: "build", attempt: 1, timestamp: "2026-08-20T12:02:00.000Z" }),
      endRow({
        node: "build",
        attempt: 1,
        timestamp: "2026-08-20T12:03:00.000Z",
        success: { costUsd: 0.42, sessions: ["b1"] }
      }),
      startRow({ node: "review", attempt: 1, timestamp: "2026-08-20T12:04:00.000Z" })
    ]
    const row = summarizeJournal(rows, "proj-abc", FRESH_MTIME, NOW).pipe(Option.getOrThrow)
    expect(row.costUsd).toBeCloseTo(0.73)
  })
})

describe("summarizeJournal — stale marker on a silent file", () => {
  const NOW = Date.parse("2026-08-20T12:05:00.000Z")

  test("mtime exactly at the threshold: not yet stale", () => {
    const mtimeMs = NOW - STALE_THRESHOLD_MS
    const row = summarizeJournal([startRow()], "proj-abc", mtimeMs, NOW).pipe(Option.getOrThrow)
    expect(row.stale).toBe(false)
  })

  test("mtime past the threshold: flagged stale, not hidden", () => {
    const mtimeMs = NOW - STALE_THRESHOLD_MS - 1
    const row = summarizeJournal([startRow()], "proj-abc", mtimeMs, NOW).pipe(Option.getOrThrow)
    expect(row.stale).toBe(true)
  })

  test("a live process outranks a silent journal: a long single-session node is not stale", () => {
    const mtimeMs = NOW - STALE_THRESHOLD_MS - 1
    const row = summarizeJournal([startRow()], "proj-abc", mtimeMs, NOW, Option.some(true)).pipe(Option.getOrThrow)
    expect(row.stale).toBe(false)
  })

  test("a dead process is stale at once, however fresh the journal", () => {
    const row = summarizeJournal([startRow()], "proj-abc", NOW, NOW, Option.some(false)).pipe(Option.getOrThrow)
    expect(row.stale).toBe(true)
  })

  test("processAlive: this process is alive, a pid nothing owns is not", () => {
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(2 ** 22 - 1)).toBe(false)
  })
})

describe("renderTable", () => {
  test("no rows: one explanatory line, not silence", () => {
    expect(renderTable([])).toBe("no active runs")
  })

  test("an active row prints project, ticket, graph, node#attempt — no stale marker", () => {
    const row = summarizeJournal([startRow()], "proj-abc", Date.parse("2026-08-20T12:04:50.000Z"), Date.parse("2026-08-20T12:05:00.000Z"))
      .pipe(Option.getOrThrow)

    const table = renderTable([row])

    expect(table).toContain("proj-abc")
    expect(table).toContain("GH-192")
    expect(table).toContain("develop-graph")
    expect(table).toContain("build#1")
    expect(table).not.toContain("stale?")
  })

  test("a stale row carries the marker on its own line", () => {
    const now = Date.parse("2026-08-20T12:05:00.000Z")
    const row = summarizeJournal([startRow()], "proj-abc", now - STALE_THRESHOLD_MS - 1, now).pipe(Option.getOrThrow)

    expect(renderTable([row])).toContain("stale?")
  })

  test("$ (est.) is the last column, right-aligned, formatted like usage-report's totals", () => {
    const now = Date.parse("2026-08-20T12:05:00.000Z")
    const rows = [
      startRow({ node: "design", attempt: 1, timestamp: "2026-08-20T12:00:00.000Z" }),
      endRow({
        node: "design",
        attempt: 1,
        timestamp: "2026-08-20T12:01:00.000Z",
        success: { costUsd: 1.5, sessions: ["a1"] }
      }),
      startRow({ node: "build", attempt: 1, timestamp: "2026-08-20T12:02:00.000Z" })
    ]
    const row = summarizeJournal(rows, "proj-abc", now, now).pipe(Option.getOrThrow)

    const table = renderTable([row])
    const [header, , dataLine] = table.split("\n")

    expect(header.trimEnd().endsWith("$ (est.)")).toBe(true)
    expect(dataLine.trimEnd().endsWith("$1.50")).toBe(true)
  })

  test("a row with no cost data renders $0.00, not blank", () => {
    const row = summarizeJournal([startRow()], "proj-abc", Date.parse("2026-08-20T12:04:50.000Z"), Date.parse("2026-08-20T12:05:00.000Z"))
      .pipe(Option.getOrThrow)

    expect(renderTable([row])).toContain("$0.00")
  })
})

describe("presentRows — stale hidden by default, shown below live with --stale", () => {
  const now = Date.parse("2026-08-20T12:05:00.000Z")
  const live = summarizeJournal([startRow({ ticket: "GH-1" })], "proj", now, now).pipe(Option.getOrThrow)
  const stale = summarizeJournal([startRow({ ticket: "GH-2" })], "proj", now - STALE_THRESHOLD_MS - 1, now).pipe(
    Option.getOrThrow
  )

  test("default hides stale rows and counts them", () => {
    const out = presentRows([stale, live], false)

    expect(out).toContain("GH-1")
    expect(out).not.toContain("GH-2")
    expect(out).toContain("(1 stale run hidden — pass --stale to show)")
  })

  test("--stale shows stale rows sorted below every live one", () => {
    const out = presentRows([stale, live], true)

    expect(out.indexOf("GH-1")).toBeLessThan(out.indexOf("GH-2"))
    expect(out).toContain("stale?")
    expect(out).not.toContain("hidden")
  })

  test("only stale rows: default prints the empty table plus the count, never silence", () => {
    const out = presentRows([stale], false)

    expect(out).toContain("no active runs")
    expect(out).toContain("(1 stale run hidden — pass --stale to show)")
  })
})

describe("presentRows — fleet total", () => {
  const now = Date.parse("2026-08-20T12:05:00.000Z")

  const rowWithCost = (ticket: string, costUsd: number) =>
    summarizeJournal(
      [
        startRow({ ticket, node: "design", attempt: 1, timestamp: "2026-08-20T12:00:00.000Z" }),
        endRow({
          ticket,
          node: "design",
          attempt: 1,
          timestamp: "2026-08-20T12:01:00.000Z",
          success: { costUsd, sessions: ["a1"] }
        }),
        startRow({ ticket, node: "build", attempt: 1, timestamp: "2026-08-20T12:02:00.000Z" })
      ],
      "proj",
      now,
      now
    ).pipe(Option.getOrThrow)

  test("a single visible run carries no fleet-total line — the row already states its own total", () => {
    const out = presentRows([rowWithCost("GH-1", 1.5)], false)
    expect(out).not.toContain("fleet total")
  })

  test("two or more visible runs get a fleet-total line under the bottom border, summed across them", () => {
    const out = presentRows([rowWithCost("GH-1", 1.5), rowWithCost("GH-2", 2.25)], false)

    const lines = out.split("\n")
    const borderIndex = lines.lastIndexOf(lines[1]) // lines[1] is the top border; the bottom one is identical

    expect(lines[borderIndex + 1]).toBe("fleet total: $3.75")
  })

  test("the fleet total counts only visible rows — a hidden stale run's cost is excluded", () => {
    const staleWithCost = summarizeJournal(
      [
        startRow({ ticket: "GH-3", node: "design", attempt: 1, timestamp: "2026-08-20T12:00:00.000Z" }),
        endRow({
          ticket: "GH-3",
          node: "design",
          attempt: 1,
          timestamp: "2026-08-20T12:01:00.000Z",
          success: { costUsd: 100, sessions: ["a1"] }
        }),
        startRow({ ticket: "GH-3", node: "build", attempt: 1, timestamp: "2026-08-20T12:02:00.000Z" })
      ],
      "proj",
      now - STALE_THRESHOLD_MS - 1,
      now
    ).pipe(Option.getOrThrow)

    const out = presentRows([rowWithCost("GH-1", 1.5), rowWithCost("GH-2", 2.25), staleWithCost], false)

    expect(out).toContain("fleet total: $3.75")
  })
})
