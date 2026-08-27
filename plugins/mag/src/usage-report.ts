import { existsSync, readFileSync } from "node:fs"
import { Predicate } from "effect"
import { decodeJournalLines } from "mag/runtime/journal/decode"
import { isEndRow, isStartRow, type JournalRow } from "mag/runtime/journal/row"
import type { Outcome } from "mag/runtime/trace/event"

/**
 * Aggregates journal rows across run directories — per-node and per-run cost and
 * wall-clock figures. Mechanical only: every figure is arithmetic over what the
 * journal holds, and a cost the journal does not hold is never invented.
 *
 *   bun plugins/mag/src/usage-report.ts [--json] <run-dir>...
 *
 * Each argument is a run directory holding a `journal.jsonl` (`run-root.ts`); an argument without
 * one is an unfit input and errors rather than being skipped.
 *
 * A run directory holds `graph/journal@3` entries, a start and an end per node run.
 * `completedNodeRuns` pairs them into one shape before anything below sees a row — a start entry
 * alone (a node still in flight) contributes nothing here, which is also what keeps a run from
 * double counting.
 *
 * The pricing rules, stated once here and applied in `summarize`:
 *
 * - A cost is read from the `success` payload of an agent-bearing completed run and from nowhere
 *   else. Agent-bearing is detected mechanically: every agent reply carries `costUsd` and
 *   `sessions` (`runtime/claude/service.ts`), so a payload owning either key is agent work. A
 *   payload owning neither is free — a script node's row, not an unpriced one. An error row has
 *   no payload at all, so a blocked pass's spend is absent by construction; this report is a
 *   documented floor, not a full accounting of every kind of cost.
 * - An agent-bearing completed run whose payload holds no numeric cost is **unpriced**:
 *   counted as work done (attempts, outcomes), kept out of every median and every total — the
 *   wall-clock medians included — and the run that holds it reads "partial" and stays out of the
 *   run-level medians.
 * - A replayed completed run is work done, never work paid for: it counts toward attempts
 *   and outcomes, and only fresh runs (`replayed: false`) contribute cost and wall-clock.
 * - Every wall-clock figure is a completed run's own end timestamp minus its start timestamp;
 *   the journal records timestamps and no duration, so this is the subtraction the report
 *   does itself, from the start entry's timestamp and the end entry's, paired by (runId, node, attempt).
 *
 * The first-pass-yield and rework figures are arithmetic over fields already on the row. Yield
 * and rework read **fresh** rows only: a replayed row's attempt is renumbered from 1 by the
 * resuming process, so counting it would credit this run with a previous run's success.
 */

/** One completed node run: a start/end pair reduced to the shape `summarize` works over. */
interface CompletedNodeRun {
  readonly runId: string
  readonly ticket: string
  readonly graph: string
  readonly pipelineSha: string
  readonly node: string
  readonly replayed: boolean
  readonly outcome: Outcome
  readonly success?: unknown
  readonly startedAt: string
  readonly endedAt: string
  /** 1-based, per node, per run: a loop re-entering the node appends a second pair (row.ts). */
  readonly attempt: number
  /** Present on `fail` and `die` when the failure carried a string `_tag` (row.ts). */
  readonly tag?: string
}

/** Keys an entry by the triple `journaled` never repeats within one run: one start and one end per (node, attempt). */
const pairKey = (runId: string, node: string, attempt: number): string => `${runId} ${node} ${attempt}`

/**
 * End entries reduced to `CompletedNodeRun`, each paired with its own start entry for its start
 * timestamp. A start entry with no matching end is a node still in flight — it
 * names nothing this report counts, so it is silently absent rather than surfaced as a zero-cost,
 * zero-duration attempt. An end entry with no matching start is not a shape `journaled` can produce
 * (the start always lands first and is never the file's torn tail, since the end that follows it
 * proves the write continued past it): treated as the unfit input it would be, not brute-forced
 * into a guessed timestamp.
 */
const completedNodeRuns = (rows: readonly JournalRow[]): readonly CompletedNodeRun[] => {
  const starts = new Map<string, string>()
  for (const row of rows) {
    if (isStartRow(row)) starts.set(pairKey(row.runId, row.node, row.attempt), row.timestamp)
  }

  const completed: CompletedNodeRun[] = []
  for (const row of rows) {
    if (!isEndRow(row)) continue
    const startedAt = starts.get(pairKey(row.runId, row.node, row.attempt))
    if (startedAt === undefined) {
      throw new Error(
        `usage-report: end entry for node "${row.node}" (run ${row.runId}, attempt ${row.attempt}) has no matching start entry`
      )
    }
    completed.push({
      runId: row.runId,
      ticket: row.ticket,
      graph: row.graph,
      pipelineSha: row.pipelineSha,
      node: row.node,
      replayed: row.replayed,
      outcome: row.outcome,
      success: row.success,
      startedAt,
      endedAt: row.timestamp,
      attempt: row.attempt,
      tag: row.tag
    })
  }
  return completed
}

/**
 * Keeps only entries stamped with the requested pipeline commit, applied before
 * pairing so a filtered-out run vanishes whole rather than tripping the end-with-no-start throw
 * above. Exact match, not a prefix: a prefix match would silently merge two commits sharing one.
 */
export const sliceByPipelineSha = (rows: readonly JournalRow[], pipelineSha: string): readonly JournalRow[] => {
  const sliced = rows.filter((row) => row.pipelineSha === pipelineSha)
  if (sliced.length === 0) {
    const present = [...new Set(rows.map((row) => row.pipelineSha))].sort()
    throw new Error(`usage-report: no entries for pipeline commit "${pipelineSha}" (present: ${present.join(", ") || "none"})`)
  }
  return sliced
}

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Nearest-rank p90: with N<10 this is the max, which is the honest answer for a sample that small
 * rather than an interpolation implying precision we lack.
 */
export const p90 = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]
}

/**
 * The per-line decode itself lives in `runtime/journal/decode.ts`'s `decodeJournalLines` —
 * the one home for a rule this module, `ps.ts` and `journal/service.ts` would otherwise each
 * carry their own copy of. This function keeps its own job, reading each directory's
 * `journal.jsonl` and refusing an argument that isn't a run directory at all, rather than
 * silently skipping it.
 */
export const collectRows = (dirs: readonly string[]): JournalRow[] => {
  const rows: JournalRow[] = []
  for (const dir of dirs) {
    const path = `${dir.replace(/\/+$/, "")}/journal.jsonl`
    if (!existsSync(path)) throw new Error(`not a run directory (no journal.jsonl): ${dir}`)
    rows.push(...decodeJournalLines(readFileSync(path, "utf8")))
  }
  return rows
}

type Pricing =
  | { readonly kind: "free" }
  | { readonly kind: "unpriced" }
  | { readonly kind: "priced"; readonly costUsd: number }

const pricingOf = (row: CompletedNodeRun): Pricing => {
  if (!Predicate.isObject(row.success)) return { kind: "free" }
  const payload: Record<string, unknown> = row.success
  if (!Object.hasOwn(payload, "costUsd") && !Object.hasOwn(payload, "sessions")) return { kind: "free" }
  const cost = payload["costUsd"]
  return Predicate.isNumber(cost) ? { kind: "priced", costUsd: cost } : { kind: "unpriced" }
}

const wallClockMs = (row: CompletedNodeRun): number => Date.parse(row.endedAt) - Date.parse(row.startedAt)

export interface NodeReport {
  readonly node: string
  /** Distinct runs the node appears in. */
  readonly runs: number
  /** Every row, replayed included — what the runs did. */
  readonly attempts: number
  /** Fresh rows with a numeric cost — the sample behind the cost figures. */
  readonly priced: number
  /** Fresh agent-bearing rows without one. */
  readonly unpriced: number
  /** Fresh rows behind the wall-clock figures. */
  readonly timed: number
  readonly medianCostUsd: number
  readonly p90CostUsd: number
  readonly totalCostUsd: number
  readonly medianMs: number
  readonly p90Ms: number
  /** Fresh node runs that ended `ok` on attempt 1. */
  readonly firstPassClean: number
  /** Fresh node runs, the denominator behind `firstPassClean`. */
  readonly firstPassOf: number
  /** The highest attempt number any fresh run of this node reached. */
  readonly peakAttempt: number
  /** Fresh node runs past attempt 1. */
  readonly reworked: number
}

/** Escalated runs sharing one recorded cause: a run's last completed node run's `tag`, else its `outcome`. */
export interface CauseReport {
  readonly cause: string
  readonly runs: number
}

/** One outcome population's cost and wall-clock, over that population's fully-priced runs. */
export interface PopulationReport {
  readonly runs: number
  readonly pricedRuns: number
  readonly medianCostUsd: number
  readonly medianMs: number
}

export interface RunReport {
  readonly runId: string
  readonly ticket: string
  readonly graph: string
  /** The executing plugin checkout's commit — reachable for a caller to group or filter by. */
  readonly pipelineSha: string
  /** Completed node runs (each start/end pair reduces to one). */
  readonly rows: number
  readonly fresh: number
  readonly replayed: number
  /** Sum of the run's fresh priced costs — a floor when the run is partial. */
  readonly costUsd: number
  /** False when a fresh agent-bearing row carries no cost — the run reads "partial". */
  readonly priced: boolean
  /** Sum of the run's fresh row durations, unpriced rows excluded. */
  readonly wallClockMs: number
  /** The run's last completed node run is not an `ok`. */
  readonly failed: boolean
  readonly endedAt: string
}

export interface Summary {
  readonly nodes: readonly NodeReport[]
  readonly runs: readonly RunReport[]
  /** Escalated runs grouped by cause, most frequent first. */
  readonly causes: readonly CauseReport[]
  /** Fresh agent-bearing rows carrying no cost, across all runs. */
  readonly unpriced: number
  readonly populations: {
    /** Runs whose last completed node run was `ok`. */
    readonly completed: PopulationReport
    /** Runs whose last completed node run was not: the `failed` predicate. */
    readonly escalated: PopulationReport
  }
  readonly totals: {
    readonly runs: number
    readonly pricedRuns: number
    readonly failedRuns: number
    readonly failedShare: number
    /** Both populations combined; `populations` above splits it. */
    readonly medianRunCostUsd: number
    readonly medianRunMs: number
    /** Every priced row across all runs — the documented floor, partial runs included. */
    readonly totalCostUsd: number
    /** Fresh node runs that ended `ok` on attempt 1, across all nodes. */
    readonly firstPassClean: number
    readonly firstPassOf: number
    /** `firstPassClean` as a share of `firstPassOf`, across all nodes, stated once here rather
     * than left for a caller to divide. */
    readonly firstPassYield: number
    /** Fresh node runs past attempt 1, across all nodes. */
    readonly reworked: number
  }
}

interface NodeAccumulator {
  readonly node: string
  readonly runIds: Set<string>
  attempts: number
  unpriced: number
  readonly costs: number[]
  readonly wallClocks: number[]
  firstPassClean: number
  firstPassOf: number
  peakAttempt: number
  reworked: number
}

interface RunAccumulator {
  readonly runId: string
  readonly ticket: string
  readonly graph: string
  readonly pipelineSha: string
  rows: number
  fresh: number
  replayed: number
  costUsd: number
  priced: boolean
  wallClockMs: number
  lastOutcome: Outcome
  /** The last completed node run's `tag`, tracked alongside `lastOutcome`. */
  lastTag?: string
  endedAt: string
}

export const summarize = (rows: readonly JournalRow[]): Summary => {
  const nodeMap = new Map<string, NodeAccumulator>()
  const runMap = new Map<string, RunAccumulator>()

  for (const row of completedNodeRuns(rows)) {
    let run = runMap.get(row.runId)
    if (run === undefined) {
      run = {
        runId: row.runId,
        ticket: row.ticket,
        graph: row.graph,
        pipelineSha: row.pipelineSha,
        rows: 0,
        fresh: 0,
        replayed: 0,
        costUsd: 0,
        priced: true,
        wallClockMs: 0,
        lastOutcome: row.outcome,
        endedAt: row.endedAt
      }
      runMap.set(row.runId, run)
    }
    run.rows += 1
    // Rows arrive in journal order (one append per node run), so the row seen last IS the run's
    // last row — the one the failure share and the escalation cause both read.
    run.lastOutcome = row.outcome
    run.lastTag = row.tag
    if (row.endedAt > run.endedAt) run.endedAt = row.endedAt

    let node = nodeMap.get(row.node)
    if (node === undefined) {
      node = {
        node: row.node,
        runIds: new Set(),
        attempts: 0,
        unpriced: 0,
        costs: [],
        wallClocks: [],
        firstPassClean: 0,
        firstPassOf: 0,
        peakAttempt: 0,
        reworked: 0
      }
      nodeMap.set(row.node, node)
    }
    node.attempts += 1
    node.runIds.add(row.runId)

    if (row.replayed) {
      run.replayed += 1
      continue
    }
    run.fresh += 1

    node.firstPassOf += 1
    if (row.attempt === 1 && row.outcome === "ok") node.firstPassClean += 1
    if (row.attempt > node.peakAttempt) node.peakAttempt = row.attempt
    if (row.attempt > 1) node.reworked += 1

    const pricing = pricingOf(row)
    if (pricing.kind === "unpriced") {
      node.unpriced += 1
      run.priced = false
      continue
    }
    if (pricing.kind === "priced") {
      node.costs.push(pricing.costUsd)
      run.costUsd += pricing.costUsd
    }
    const ms = wallClockMs(row)
    if (Number.isFinite(ms)) {
      node.wallClocks.push(ms)
      run.wallClockMs += ms
    }
  }

  const nodes = [...nodeMap.values()]
    .map((n): NodeReport => ({
      node: n.node,
      runs: n.runIds.size,
      attempts: n.attempts,
      priced: n.costs.length,
      unpriced: n.unpriced,
      timed: n.wallClocks.length,
      medianCostUsd: median(n.costs),
      p90CostUsd: p90(n.costs),
      totalCostUsd: n.costs.reduce((a, b) => a + b, 0),
      medianMs: median(n.wallClocks),
      p90Ms: p90(n.wallClocks),
      firstPassClean: n.firstPassClean,
      firstPassOf: n.firstPassOf,
      peakAttempt: n.peakAttempt,
      reworked: n.reworked
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd || a.node.localeCompare(b.node))

  const runs = [...runMap.values()]
    .map((r): RunReport => ({
      runId: r.runId,
      ticket: r.ticket,
      graph: r.graph,
      pipelineSha: r.pipelineSha,
      rows: r.rows,
      fresh: r.fresh,
      replayed: r.replayed,
      costUsd: r.costUsd,
      priced: r.priced,
      wallClockMs: r.wallClockMs,
      failed: r.lastOutcome !== "ok",
      endedAt: r.endedAt
    }))
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt))

  const pricedRuns = runs.filter((r) => r.priced)

  const causeCounts = new Map<string, number>()
  for (const r of runMap.values()) {
    if (r.lastOutcome === "ok") continue
    const cause = r.lastTag ?? r.lastOutcome
    causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1)
  }
  const causes = [...causeCounts.entries()]
    .map(([cause, count]): CauseReport => ({ cause, runs: count }))
    .sort((a, b) => b.runs - a.runs || a.cause.localeCompare(b.cause))

  const populationOf = (escalated: boolean): PopulationReport => {
    const pop = runs.filter((r) => r.failed === escalated)
    const priced = pop.filter((r) => r.priced)
    return {
      runs: pop.length,
      pricedRuns: priced.length,
      medianCostUsd: median(priced.map((r) => r.costUsd)),
      medianMs: median(priced.map((r) => r.wallClockMs))
    }
  }
  const populations = { completed: populationOf(false), escalated: populationOf(true) }
  const failedRuns = populations.escalated.runs

  const firstPassClean = nodes.reduce((a, n) => a + n.firstPassClean, 0)
  const firstPassOf = nodes.reduce((a, n) => a + n.firstPassOf, 0)

  return {
    nodes,
    runs,
    causes,
    unpriced: nodes.reduce((a, n) => a + n.unpriced, 0),
    populations,
    totals: {
      runs: runs.length,
      pricedRuns: pricedRuns.length,
      failedRuns,
      failedShare: runs.length === 0 ? 0 : failedRuns / runs.length,
      medianRunCostUsd: median(pricedRuns.map((r) => r.costUsd)),
      medianRunMs: median(pricedRuns.map((r) => r.wallClockMs)),
      totalCostUsd: runs.reduce((a, r) => a + r.costUsd, 0),
      firstPassClean,
      firstPassOf,
      firstPassYield: firstPassOf === 0 ? 0 : firstPassClean / firstPassOf,
      reworked: nodes.reduce((a, n) => a + n.reworked, 0)
    }
  }
}

/** Exported so `ps.ts`'s `$ (est.)` column formats the same way this report does. */
export const usd = (n: number): string => `$${n.toFixed(2)}`

export const fmtMs = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n)
const padL = (s: string | number, n: number): string => String(s).padStart(n)

export const render = (sum: Summary): string => {
  if (sum.runs.length === 0) return "no journal rows found under the given run directories"

  const out: string[] = []

  // Names the slice every figure below covers, so a mixed read never passes for one commit.
  const shas = [...new Set(sum.runs.map((r) => r.pipelineSha))]
  out.push(shas.length === 1 ? `pipeline sha: ${shas[0]}` : `pipeline sha: mixed (${shas.length})`, "")

  out.push("Per node — fresh cost and wall-clock across runs", "")
  out.push(
    `${pad("node", 18)}${padL("runs", 5)}${padL("attempts", 9)}${padL("median", 9)}${padL("p90", 9)}${padL("total", 10)}${padL("med wall", 10)}${padL("p90 wall", 10)}`
  )
  out.push("-".repeat(80))
  for (const n of sum.nodes) {
    const cost = (value: number) => (n.priced > 0 ? usd(value) : "-")
    const wall = (value: number) => (n.timed > 0 ? fmtMs(value) : "-")
    out.push(
      `${pad(n.node, 18)}${padL(n.runs, 5)}${padL(n.attempts, 9)}${padL(cost(n.medianCostUsd), 9)}${padL(cost(n.p90CostUsd), 9)}${padL(cost(n.totalCostUsd), 10)}${padL(wall(n.medianMs), 10)}${padL(wall(n.p90Ms), 10)}`
    )
  }

  const yieldRow = (label: string, of: number, clean: number, peak: string | number, reworked: number): string =>
    `${pad(label, 18)}${padL(of, 6)}${padL(clean, 7)}${padL(of > 0 ? `${Math.round((clean / of) * 100)}%` : "-", 7)}${padL(peak, 6)}${padL(reworked, 10)}`

  out.push("", "Per node — first-pass yield and rework", "")
  out.push(`${pad("node", 18)}${padL("of", 6)}${padL("clean", 7)}${padL("yield", 7)}${padL("peak", 6)}${padL("reworked", 10)}`)
  out.push("-".repeat(54))
  for (const n of sum.nodes) out.push(yieldRow(n.node, n.firstPassOf, n.firstPassClean, n.peakAttempt, n.reworked))
  // The "across all nodes" share, not just each row's own — a totals row so the
  // rendered output states it too, not only the `--json` totals block.
  out.push("-".repeat(54))
  out.push(yieldRow("all nodes", sum.totals.firstPassOf, sum.totals.firstPassClean, "-", sum.totals.reworked))

  out.push("", "Per run", "")
  out.push(
    `${pad("run", 16)}${pad("ticket", 10)}${pad("graph", 14)}${padL("rows", 5)}${padL("fresh", 6)}${padL("cost", 10)}${padL("wall", 8)}  outcome`
  )
  out.push("-".repeat(80))
  for (const r of sum.runs) {
    out.push(
      `${pad(r.runId, 16)}${pad(r.ticket, 10)}${pad(r.graph, 14)}${padL(r.rows, 5)}${padL(r.fresh, 6)}${padL(r.priced ? usd(r.costUsd) : "partial", 10)}${padL(fmtMs(r.wallClockMs), 8)}  ${r.failed ? "escalated" : "completed"}`
    )
  }

  out.push("", "Escalations by cause", "")
  if (sum.causes.length === 0) {
    out.push("(none)")
  } else {
    out.push(`${pad("cause", 24)}${padL("runs", 5)}`)
    out.push("-".repeat(29))
    for (const c of sum.causes) out.push(`${pad(c.cause, 24)}${padL(c.runs, 5)}`)
  }

  const popWall = (p: PopulationReport): string => (p.pricedRuns > 0 ? fmtMs(p.medianMs) : "-")

  out.push("", "Cost and wall-clock by population", "")
  out.push(`${pad("population", 12)}${padL("runs", 5)}${padL("priced", 7)}${padL("median", 9)}${padL("med wall", 10)}`)
  out.push("-".repeat(43))
  for (const [label, p] of [["completed", sum.populations.completed], ["escalated", sum.populations.escalated]] as const) {
    const cost = p.pricedRuns > 0 ? usd(p.medianCostUsd) : "-"
    out.push(`${pad(label, 12)}${padL(p.runs, 5)}${padL(p.pricedRuns, 7)}${padL(cost, 9)}${padL(popWall(p), 10)}`)
  }

  const t = sum.totals
  const failedPct = Math.round(t.failedShare * 100)
  out.push("")
  out.push(
    `runs: ${t.runs} (${t.pricedRuns} fully priced, ${t.failedRuns} escalated, ${failedPct}%)   median run: ${usd(t.medianRunCostUsd)} / ${fmtMs(t.medianRunMs)} (priced runs, both populations)   total: ${usd(t.totalCostUsd)}`
  )
  // States escalated share and completed-run median as their own line, for comparing across runs.
  out.push(`escalated: ${t.failedRuns} of ${t.runs} runs (${failedPct}%)   completed-run median: ${popWall(sum.populations.completed)}`)
  if (sum.unpriced > 0) {
    out.push(
      `note: ${sum.unpriced} agent row(s) carry no cost — counted as unpriced, kept out of every median and total; their runs read "partial" and the total is a floor.`
    )
  }
  return out.join("\n")
}

const USAGE = "usage: bun plugins/mag/src/usage-report.ts [--json] [--pipeline-sha <sha>] <run-dir>..."

export interface CliArgs {
  readonly dirs: readonly string[]
  readonly json: boolean
  readonly help: boolean
  readonly pipelineSha?: string
}

/**
 * Pulled out of the `import.meta.main` block so its one loud failure — `--pipeline-sha`
 * given with no value following it — is reachable by a test, not only by running the binary. That
 * trailing flag is unfit input (PRINCIPLES.md, "Unfit paths should error"): falling back to the
 * unfiltered corpus would answer a slice request with the whole thing, silently.
 */
export const parseArgs = (argv: readonly string[]): CliArgs => {
  const dirs: string[] = []
  let json = false
  let help = false
  let pipelineSha: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--json") json = true
    else if (arg === "-h" || arg === "--help") help = true
    else if (arg === "--pipeline-sha") {
      const value = argv[++i]
      if (value === undefined) throw new Error("usage-report: --pipeline-sha requires a value")
      pipelineSha = value
    } else dirs.push(arg)
  }
  return { dirs, json, help, pipelineSha }
}

if (import.meta.main) {
  try {
    const { dirs, help, json, pipelineSha } = parseArgs(process.argv.slice(2))
    if (help) {
      console.log(USAGE)
      process.exit(0)
    }
    if (dirs.length === 0) {
      console.error(USAGE)
      process.exit(1)
    }
    const rows = collectRows(dirs)
    const summary = summarize(pipelineSha === undefined ? rows : sliceByPipelineSha(rows, pipelineSha))
    console.log(json ? JSON.stringify(summary, null, 2) : render(summary))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
