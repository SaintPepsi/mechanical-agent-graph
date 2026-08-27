import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { platform } from "mag/runtime/platform"
import { collectRows, fmtMs, median, p90, parseArgs, render, sliceByPipelineSha, summarize } from "mag/usage-report"

/**
 * Fixture journals, not live runs. `row` describes one completed node run and splits it into
 * the start/end pair `row.ts` actually writes — no single-row shape exists — so the
 * report is tested against the contract it reads, with the timestamps chosen to make every
 * wall-clock figure checkable by hand.
 */

/** Deletes a fixture directory, and only a fixture directory: anything outside tmpdir is refused. */
const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

const at = (second: number): string => `2026-08-18T12:00:${String(second).padStart(2, "0")}.000Z`

/** One completed node run, defaults included — the fields `row` below splits across its pair. */
const flatRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  runId: "r1",
  ticket: "GH-143",
  graph: "develop-graph",
  repoRoot: "/repo",
  sha: "abc1234",
  pipelineSha: "def4567",
  node: "build",
  attempt: 1,
  replayed: false,
  startedAt: at(0),
  endedAt: at(10),
  outcome: "ok",
  success: { sessions: ["s1"], costUsd: 1 },
  ...over
})

/**
 * The start/end pair `journaled.ts` actually appends for one completed node run. `outcome`,
 * `tag`, `success` and `replayed` land on the end entry only, matching `row.ts`'s own builders — a
 * start entry never carries them.
 */
const row = (over: Record<string, unknown>): readonly [Record<string, unknown>, Record<string, unknown>] => {
  const { runId, ticket, graph, repoRoot, sha, pipelineSha, node, attempt, startedAt, endedAt, replayed, outcome, tag, success } =
    flatRow(over)
  const stamp = { runId, ticket, graph, repoRoot, sha, pipelineSha, node, attempt }
  return [
    { schema: "graph/journal@3", ...stamp, event: "start", timestamp: startedAt },
    { schema: "graph/journal@3", ...stamp, event: "end", timestamp: endedAt, replayed, outcome, tag, success }
  ]
}

/** Flattens `row`'s pairs (and passes any raw fixture object through unchanged) into one line per entry. */
const writeRun = (
  root: string,
  name: string,
  rows: ReadonlyArray<Record<string, unknown> | readonly Record<string, unknown>[]>
): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "journal.jsonl"), rows.flat().map((r) => JSON.stringify(r)).join("\n") + "\n")
  return dir
}

const inTemp = async (body: (root: string) => void | Promise<void>): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "graph-usage-report-"))
  try {
    await body(root)
  } finally {
    await removeDir(root)
  }
}

/** Round-trips literal rows through real journal files, so every test reads what a run writes. */
const collectRowsFrom = async (
  runs: ReadonlyArray<ReadonlyArray<Record<string, unknown> | readonly Record<string, unknown>[]>>
) => {
  const root = mkdtempSync(join(tmpdir(), "graph-usage-report-"))
  try {
    return collectRows(runs.map((rows, i) => writeRun(root, `run-${i}`, rows)))
  } finally {
    await removeDir(root)
  }
}

describe("median / p90", () => {
  test("median of an even sample averages the middle pair; both return 0 on empty", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(0)
    expect(p90([])).toBe(0)
  })

  test("nearest-rank p90 is the max for a sample under ten", () => {
    expect(p90([1, 2, 9])).toBe(9)
    expect(p90(Array.from({ length: 10 }, (_, i) => i + 1))).toBe(9)
  })
})

describe("collectRows", () => {
  test("reads journal.jsonl from each run directory and skips a malformed tail line", async () => {
    await inTemp((root) => {
      const a = writeRun(root, "a", [row({})[1]])
      const b = join(root, "b")
      mkdirSync(b)
      writeFileSync(join(b, "journal.jsonl"), JSON.stringify(row({ runId: "r2" })[1]) + '\n{"schema":"mag/jour')

      const rows = collectRows([a, b])
      expect(rows.map((r) => r.runId)).toEqual(["r1", "r2"])
    })
  })

  test("a line that parses but decodes as neither entry shape is skipped by the same rule", async () => {
    await inTemp((root) => {
      const dir = writeRun(root, "a", [row({}), { schema: "graph/journal@3", nope: true }])
      expect(collectRows([dir])).toHaveLength(2)
    })
  })

  test("a directory without a journal is an unfit input and errors, never a silent skip", async () => {
    await inTemp((root) => {
      expect(() => collectRows([join(root, "missing")])).toThrow("no journal.jsonl")
    })
  })
})

describe("per-node aggregates", () => {
  test("run count, attempt count, cost median/p90/total and wall-clock from the rows' own timestamps", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [
          row({ runId: "r1", node: "build", startedAt: at(0), endedAt: at(10), success: { sessions: ["a"], costUsd: 1 } }),
          row({ runId: "r1", node: "build", attempt: 2, startedAt: at(10), endedAt: at(40), success: { sessions: ["b"], costUsd: 3 } })
        ],
        [
          row({ runId: "r2", node: "build", startedAt: at(0), endedAt: at(20), success: { sessions: ["c"], costUsd: 2 } })
        ]
      ])
    )

    const build = sum.nodes.find((n) => n.node === "build")
    expect(build).toMatchObject({
      runs: 2,
      attempts: 3,
      priced: 3,
      medianCostUsd: 2,
      p90CostUsd: 3,
      totalCostUsd: 6,
      medianMs: 20_000,
      p90Ms: 30_000
    })
  })

  test("a payload owning neither costUsd nor sessions is free — timed, never priced or unpriced", async () => {
    const sum = summarize(
      await collectRowsFrom([[row({ node: "branch", startedAt: at(0), endedAt: at(2), success: { created: true } })]])
    )

    expect(sum.nodes[0]).toMatchObject({ node: "branch", priced: 0, unpriced: 0, timed: 1, medianMs: 2_000 })
    expect(sum.unpriced).toBe(0)
    expect(sum.runs[0]?.priced).toBe(true)
  })
})

describe("per-run aggregates", () => {
  test("median run cost, median run wall-clock, and the share of runs whose last row is a failure", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [
          row({ runId: "r1", startedAt: at(0), endedAt: at(10), success: { sessions: ["a"], costUsd: 1 } }),
          row({ runId: "r1", node: "review-diff", startedAt: at(10), endedAt: at(20), success: { sessions: ["b"], costUsd: 1 } })
        ],
        [row({ runId: "r2", startedAt: at(0), endedAt: at(30), success: { sessions: ["c"], costUsd: 4 } })],
        [
          row({ runId: "r3", startedAt: at(0), endedAt: at(5), success: { sessions: ["d"], costUsd: 2 } }),
          row({ runId: "r3", node: "verification", outcome: "fail", tag: "VERIFICATION_FAILED", success: undefined, startedAt: at(5), endedAt: at(9) })
        ]
      ])
    )

    expect(sum.totals.runs).toBe(3)
    expect(sum.totals.medianRunCostUsd).toBe(2)
    expect(sum.totals.medianRunMs).toBe(20_000)
    expect(sum.totals.failedRuns).toBe(1)
    expect(sum.totals.failedShare).toBeCloseTo(1 / 3)
    expect(sum.runs.find((r) => r.runId === "r3")?.failed).toBe(true)
  })

  test("a failure mid-run does not mark a run that ends on an ok row", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [
          row({ outcome: "fail", tag: "BOOM", success: undefined }),
          row({ attempt: 2, success: { sessions: ["a"], costUsd: 1 } })
        ]
      ])
    )
    expect(sum.runs[0]?.failed).toBe(false)
  })
})

describe("pipeline commit is a run report value", () => {
  test("runs from two pipeline commits carry their own pipelineSha, and a blank one is its own value", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [row({ runId: "r1", pipelineSha: "aaa1111" })],
        [row({ runId: "r2", pipelineSha: "bbb2222" })],
        [row({ runId: "r3", pipelineSha: "" })]
      ])
    )

    expect(sum.runs.find((r) => r.runId === "r1")?.pipelineSha).toBe("aaa1111")
    expect(sum.runs.find((r) => r.runId === "r2")?.pipelineSha).toBe("bbb2222")
    expect(sum.runs.find((r) => r.runId === "r3")?.pipelineSha).toBe("")
  })
})

describe("a missing cost is never zero", () => {
  test("costUsd: null makes the row unpriced, the run partial, and stays out of every median and total", async () => {
    await inTemp((root) => {
      const priced = writeRun(root, "priced", [
        row({ runId: "r1", startedAt: at(0), endedAt: at(10), success: { sessions: ["a"], costUsd: 2 } })
      ])
      const partial = writeRun(root, "partial", [
        row({ runId: "r2", startedAt: at(0), endedAt: at(10), success: { sessions: ["b"], costUsd: 2 } }),
        row({ runId: "r2", node: "review-diff", startedAt: at(10), endedAt: at(70), success: { sessions: ["c"], costUsd: null } })
      ])

      const sum = summarize(collectRows([priced, partial]))

      const reviewDiff = sum.nodes.find((n) => n.node === "review-diff")
      expect(reviewDiff).toMatchObject({ attempts: 1, priced: 0, unpriced: 1, timed: 0, totalCostUsd: 0 })
      expect(sum.unpriced).toBe(1)

      const r2 = sum.runs.find((r) => r.runId === "r2")
      expect(r2?.priced).toBe(false)
      // The partial run's priced rows still reach the floor total; the unpriced row adds nothing.
      expect(r2?.costUsd).toBe(2)
      expect(sum.totals.totalCostUsd).toBe(4)
      // Run-level medians read priced runs only, so the partial run distorts neither.
      expect(sum.totals.pricedRuns).toBe(1)
      expect(sum.totals.medianRunCostUsd).toBe(2)
      expect(sum.totals.medianRunMs).toBe(10_000)
    })
  })

  test("a payload that owns sessions but no costUsd key at all is unpriced the same way", async () => {
    const sum = summarize(await collectRowsFrom([[row({ success: { sessions: ["a"] } })]]))
    expect(sum.nodes[0]).toMatchObject({ priced: 0, unpriced: 1 })
    expect(sum.runs[0]?.priced).toBe(false)
  })
})

describe("replayed rows are work done, never work paid for", () => {
  test("replayed rows count toward attempts, and only fresh rows reach cost and wall-clock", async () => {
    await inTemp((root) => {
      const resumed = writeRun(root, "resumed", [
        row({ runId: "r1", node: "fetch-ticket", replayed: true, startedAt: at(0), endedAt: at(1), success: { title: "t" } }),
        row({ runId: "r1", node: "build", replayed: true, startedAt: at(1), endedAt: at(2), success: { sessions: ["a"], costUsd: 9 } }),
        row({ runId: "r1", node: "review-diff", startedAt: at(2), endedAt: at(32), success: { sessions: ["b"], costUsd: 1 } })
      ])

      const sum = summarize(collectRows([resumed]))

      const build = sum.nodes.find((n) => n.node === "build")
      expect(build).toMatchObject({ attempts: 1, priced: 0, timed: 0, totalCostUsd: 0 })

      const run = sum.runs[0]
      expect(run).toMatchObject({ rows: 3, fresh: 1, replayed: 2, costUsd: 1, priced: true, wallClockMs: 30_000 })
      expect(sum.totals.totalCostUsd).toBe(1)
    })
  })

  test("a replayed agent row copied without a cost does not mark the resumed run partial", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [
          row({ node: "build", replayed: true, success: { sessions: ["a"], costUsd: null } }),
          row({ node: "review-diff", attempt: 1, success: { sessions: ["b"], costUsd: 1 } })
        ]
      ])
    )
    expect(sum.runs[0]?.priced).toBe(true)
    expect(sum.unpriced).toBe(0)
  })
})

describe("costs come from success payloads only", () => {
  test("an error row carries no payload and contributes no cost, only an attempt and its outcome", async () => {
    const sum = summarize(
      await collectRowsFrom([[row({ node: "review-diff", outcome: "fail", tag: "REVIEW_BLOCKED", success: undefined })]])
    )

    expect(sum.nodes[0]).toMatchObject({ node: "review-diff", attempts: 1, priced: 0, unpriced: 0, totalCostUsd: 0 })
    expect(sum.totals.totalCostUsd).toBe(0)
    expect(sum.runs[0]?.failed).toBe(true)
  })
})

describe("an unpaired entry", () => {
  test("a start entry with no matching end (a node still in flight) is silently absent, not a zero-duration attempt", async () => {
    await inTemp((root) => {
      const dir = writeRun(root, "inflight", [row({ runId: "r1", node: "build" })[0]])

      const sum = summarize(collectRows([dir]))

      expect(sum.nodes).toHaveLength(0)
      expect(sum.runs).toHaveLength(0)
    })
  })

  test("an end entry with no matching start is the unfit input it would be, not brute-forced into a guessed timestamp", async () => {
    await inTemp((root) => {
      const dir = writeRun(root, "torn", [row({ runId: "r1", node: "build" })[1]])

      expect(() => summarize(collectRows([dir]))).toThrow("no matching start entry")
    })
  })
})

describe("render", () => {
  test("a partial run prints 'partial', never a number, and the unpriced note names the floor", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [row({ success: { sessions: ["a"], costUsd: null } })],
        [row({ runId: "r2", success: { sessions: ["b"], costUsd: 1.5 } })]
      ])
    )
    const text = render(sum)
    expect(text).toContain("partial")
    expect(text).toContain("$1.50")
    expect(text).toContain("1 agent row(s) carry no cost")
  })

  test("an empty summary says so instead of printing empty tables", () => {
    expect(render(summarize([]))).toContain("no journal rows found")
  })

  test("wall-clock renders as seconds under a minute and m/s above it", () => {
    expect(fmtMs(9_400)).toBe("9s")
    expect(fmtMs(90_000)).toBe("1m30s")
  })
})

/** One completed node run that ended in a failure: the shape the escalation fixtures below share. */
const failedRow = (over: Record<string, unknown> = {}) => row({ outcome: "fail", tag: "BOOM", success: undefined, ...over })

describe("first-pass yield", () => {
  test("an attempt-1 ok and a reworked node report the per-node clean/of split; totals sum across nodes", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [
          row({ runId: "r1", node: "build", attempt: 1, outcome: "ok", startedAt: at(0), endedAt: at(5) }),
          row({ runId: "r1", node: "review-diff", attempt: 1, outcome: "ok", startedAt: at(5), endedAt: at(8) })
        ],
        [
          failedRow({ runId: "r2", node: "build", attempt: 1, startedAt: at(0), endedAt: at(2) }),
          row({ runId: "r2", node: "build", attempt: 2, outcome: "ok", startedAt: at(2), endedAt: at(6) })
        ]
      ])
    )

    expect(sum.nodes.find((n) => n.node === "build")).toMatchObject({ firstPassOf: 3, firstPassClean: 1 })
    expect(sum.nodes.find((n) => n.node === "review-diff")).toMatchObject({ firstPassOf: 1, firstPassClean: 1 })
    expect(sum.totals.firstPassOf).toBe(4)
    expect(sum.totals.firstPassClean).toBe(2)
  })

  test("render states the across-all-nodes share, not just each node's own row", async () => {
    // review-diff attempts once. `build` succeeds attempt 1, so the split (build 1/1, review-diff
    // 0/1) makes the 50% overall figure distinguishable from either node's own 100%/0% row.
    const sum = summarize(
      await collectRowsFrom([
        [
          row({ runId: "r1", node: "build", attempt: 1, outcome: "ok" }),
          failedRow({ runId: "r1", node: "review-diff", attempt: 1 })
        ]
      ])
    )
    expect(sum.totals.firstPassYield).toBeCloseTo(0.5)
    expect(render(sum)).toMatch(/all nodes\s+2\s+1\s+50%/)
  })

  test("a replayed ok at attempt 1 counts toward neither numerator nor denominator", async () => {
    // A resume renumbers its replayed prefix's attempts from 1, so counting a
    // replayed row here would credit this run with a previous run's success.
    const sum = summarize(
      await collectRowsFrom([
        [
          row({ runId: "r1", node: "fetch-ticket", attempt: 1, replayed: true, outcome: "ok", success: { title: "t" } }),
          row({ runId: "r1", node: "build", attempt: 1, outcome: "ok" })
        ]
      ])
    )
    expect(sum.nodes.find((n) => n.node === "fetch-ticket")).toMatchObject({ firstPassOf: 0, firstPassClean: 0 })
  })
})

describe("rework", () => {
  test("three attempts on one node peak at 3 with 2 reworked; a node entered once peaks at 1 with 0 reworked", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [
          failedRow({ runId: "r1", node: "build", attempt: 1, startedAt: at(0), endedAt: at(1) }),
          failedRow({ runId: "r1", node: "build", attempt: 2, startedAt: at(1), endedAt: at(2) }),
          row({ runId: "r1", node: "build", attempt: 3, outcome: "ok", startedAt: at(2), endedAt: at(3) }),
          row({ runId: "r1", node: "review-diff", attempt: 1, outcome: "ok", startedAt: at(3), endedAt: at(4) })
        ]
      ])
    )
    expect(sum.nodes.find((n) => n.node === "build")).toMatchObject({ peakAttempt: 3, reworked: 2 })
    expect(sum.nodes.find((n) => n.node === "review-diff")).toMatchObject({ peakAttempt: 1, reworked: 0 })
    expect(sum.totals.reworked).toBe(2)
  })
})

describe("escalation by cause", () => {
  test("runs group by their last row's tag, most frequent first; a completed run contributes no bucket", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [failedRow({ runId: "r1", tag: "VERIFICATION_FAILED" })],
        [failedRow({ runId: "r2", tag: "REVIEW_BLOCKED" })],
        [failedRow({ runId: "r3", tag: "VERIFICATION_FAILED" })],
        [row({ runId: "r4", outcome: "ok" })]
      ])
    )
    expect(sum.causes).toEqual([
      { cause: "VERIFICATION_FAILED", runs: 2 },
      { cause: "REVIEW_BLOCKED", runs: 1 }
    ])
  })

  test("a tagless interrupt buckets under its outcome, never a guessed tag", async () => {
    const sum = summarize(
      await collectRowsFrom([[failedRow({ outcome: "interrupt", tag: undefined })]])
    )
    expect(sum.causes).toEqual([{ cause: "interrupt", runs: 1 }])
  })

  test("cause counts sum to totals.failedRuns, the tally identity the report is its own check for", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [failedRow({ runId: "r1", tag: "A" })],
        [failedRow({ runId: "r2", outcome: "die", tag: "B" })],
        [row({ runId: "r3", outcome: "ok" })]
      ])
    )
    expect(sum.causes.reduce((a, c) => a + c.runs, 0)).toBe(sum.totals.failedRuns)
  })
})

describe("populations reported apart", () => {
  test("completed and escalated runs report separate counts and medians, and they sum to totals.runs", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [row({ runId: "r1", outcome: "ok", startedAt: at(0), endedAt: at(10), success: { sessions: ["a"], costUsd: 2 } })],
        [row({ runId: "r2", outcome: "ok", startedAt: at(0), endedAt: at(20), success: { sessions: ["b"], costUsd: 4 } })],
        [failedRow({ runId: "r3", startedAt: at(0), endedAt: at(5) })],
        [failedRow({ runId: "r4", startedAt: at(0), endedAt: at(9) })]
      ])
    )

    expect(sum.populations.completed).toMatchObject({ runs: 2, pricedRuns: 2, medianCostUsd: 3, medianMs: 15_000 })
    expect(sum.populations.escalated.runs).toBe(2)
    expect(sum.populations.completed.runs + sum.populations.escalated.runs).toBe(sum.totals.runs)
  })

  test("a partial run is counted in its population's runs but excluded from pricedRuns and both medians", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [row({ runId: "r1", outcome: "ok", startedAt: at(0), endedAt: at(10), success: { sessions: ["a"], costUsd: 2 } })],
        [row({ runId: "r2", outcome: "ok", startedAt: at(0), endedAt: at(10), success: { sessions: ["b"], costUsd: null } })]
      ])
    )
    expect(sum.populations.completed).toMatchObject({ runs: 2, pricedRuns: 1, medianCostUsd: 2, medianMs: 10_000 })
  })

  test("render labels the combined median as covering both populations", async () => {
    const sum = summarize(await collectRowsFrom([[row({})]]))
    expect(render(sum)).toContain("both populations")
  })
})

describe("baseline-comparable line", () => {
  test("render states the escalated share of runs and the completed-run median wall-clock", async () => {
    const sum = summarize(
      await collectRowsFrom([
        [row({ runId: "r1", outcome: "ok", startedAt: at(0), endedAt: at(90) })],
        [failedRow({ runId: "r2" })]
      ])
    )
    const text = render(sum)
    expect(text).toContain("escalated: 1 of 2 runs (50%)")
    expect(text).toContain(`completed-run median: ${fmtMs(sum.populations.completed.medianMs)}`)
  })
})

describe("diagnostics stay in the report", () => {
  test("no file under graph-nodes/ imports mag/usage-report or names its figures in prose", () => {
    const root = join(import.meta.dir, "graph-nodes")
    const files = readdirSync(root, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => join(root, entry))

    const banned = ["mag/usage-report", "first-pass yield", "escalation rate", "rework"]
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      for (const phrase of banned) {
        expect(text.includes(phrase), `${file} must not contain "${phrase}"`).toBe(false)
      }
    }
  })
})

describe("sliceable by pipeline commit", () => {
  test("restricts the node table, run list, causes and both populations to the requested commit", async () => {
    const rows = await collectRowsFrom([
      [row({ runId: "r1", pipelineSha: "aaa1111", node: "build", outcome: "ok" })],
      [failedRow({ runId: "r2", pipelineSha: "bbb2222", node: "build" })]
    ])

    const sum = summarize(sliceByPipelineSha(rows, "aaa1111"))
    expect(sum.runs.map((r) => r.runId)).toEqual(["r1"])
    expect(sum.nodes.find((n) => n.node === "build")).toMatchObject({ runs: 1 })
    expect(sum.causes).toEqual([])
    expect(sum.populations.completed.runs).toBe(1)
    expect(sum.populations.escalated.runs).toBe(0)
  })

  test("a commit matching nothing throws, naming the requested commit and the commits present", async () => {
    const rows = await collectRowsFrom([[row({ pipelineSha: "aaa1111" })]])
    expect(() => sliceByPipelineSha(rows, "zzz9999")).toThrow(/zzz9999/)
    expect(() => sliceByPipelineSha(rows, "zzz9999")).toThrow(/aaa1111/)
  })
})

describe("CLI argument parsing", () => {
  test("--pipeline-sha with no value is unfit input, not a silent fall-through to the unfiltered corpus", () => {
    expect(() => parseArgs(["runs/a", "--pipeline-sha"])).toThrow("--pipeline-sha requires a value")
  })

  test("--json, --pipeline-sha <value> and positionals land in their own fields", () => {
    expect(parseArgs(["--json", "--pipeline-sha", "abc1234", "runs/a", "runs/b"])).toEqual({
      dirs: ["runs/a", "runs/b"],
      json: true,
      help: false,
      pipelineSha: "abc1234"
    })
  })

  test("-h / --help sets help without consuming a directory", () => {
    expect(parseArgs(["--help"])).toMatchObject({ help: true, dirs: [] })
  })
})
