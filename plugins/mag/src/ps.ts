import { Array as Arr, Console, DateTime, Duration, Effect, FileSystem, Option, Path, Predicate, Schedule } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { decodeJournalLines } from "mag/runtime/journal/decode"
import { isEndRow, isStartRow, type JournalRow } from "mag/runtime/journal/row"
import { platform } from "mag/runtime/platform"
import { PID_FILE, RunRootEnv } from "mag/runtime/run-layers"
import { graphRoot } from "mag/runtime/run-root"
import { fmtMs, usd } from "mag/usage-report"

/**
 * `mag ps` — every run currently active on this machine, read straight off the journals
 * under `<config>/graph/<project-key>/<ticket>/<run-id>/journal.jsonl` (`run-root.ts`). Entering
 * and exiting a node are two separate journal entries, which is what makes "active" a
 * precise, mechanical read: a journal whose last row is a `start` has no matching `end` yet, so that
 * node is running right now. A journal whose last row is an `end` has finished and is
 * excluded.
 *
 * Read-only by construction: this module only ever calls `readDirectory`, `readFileString`
 * and `stat`. It also never runs through `journaled`/`make` — every GraphNode's stdout contract
 * (`render.ts`'s `renderSuccess`) is one JSON line, the machine-consumable shape a graph step's
 * caller wants, and that is the wrong shape for a live status table a human reads at a glance. `ps`
 * is wired as a plain `effect/unstable/cli` command instead, through `build-cli.ts`'s `"raw"`
 * registry entry, which folds a pre-built `Command` into the tree unchanged rather than through
 * `toCommand`'s GraphNode pipeline.
 */

/**
 * The fallback for a run with no pidfile (written before the pidfile existed): a journal silent
 * this long is flagged, not hidden. A run with a pidfile is live exactly while its process is.
 */
export const STALE_THRESHOLD_MS = 45 * 60 * 1000

/** Signal 0 sends nothing and only asks: ESRCH is dead, EPERM is alive but someone else's. */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export interface PsRow {
  readonly projectKey: string
  readonly ticket: string
  readonly graph: string
  readonly runId: string
  readonly node: string
  readonly attempt: number
  readonly nodeElapsedMs: number
  readonly runElapsedMs: number
  readonly stale: boolean
  /** Summed off every `end` row's `success.costUsd`, missing/non-numeric treated as zero — a floor, never a guess. */
  readonly costUsd: number
}

// `decodeJournalLines` lives in `runtime/journal/decode.ts`, the one home for a decode this
// module, `usage-report.ts`, and `journal/service.ts` would otherwise each carry their own copy of.
// Re-exported here (the import above brings the binding in) so this module's own callers below and
// its test reach it through `mag/ps`.
export { decodeJournalLines }

/**
 * One `end` row's contribution to the running total. `success` is `Schema.Unknown` on
 * the row (`journal/row.ts`) and, per node, either absent, `null` (`costUsd: Schema.NullOr(Schema.Number)`
 * on every agent-bearing GraphNode — `graph-nodes/build/graph-node.ts` etc.) or a number. Any other
 * shape reads as zero rather than being fabricated: the column is a floor, never a guess.
 */
const endRowCostUsd = (row: JournalRow): number => {
  if (!isEndRow(row) || !Predicate.isObject(row.success)) return 0
  const cost = (row.success as Record<string, unknown>)["costUsd"]
  return Predicate.isNumber(cost) ? cost : 0
}

/**
 * `Option.none` when there is nothing to report for this journal: no decodable rows at all, or every
 * `start` has its matching `end` (the run finished). Active means an unmatched start exists —
 * not "the last row is a start": under a fork (`Graph.construct`'s `.fork`) two nodes run
 * concurrently and one side's `end` can be the newest row while the other side is still mid-flight,
 * which a last-row heuristic would misread as finished. The most
 * recently opened unmatched start names the current node; the first row's timestamp is when the run
 * began. `costUsd` sums every `end` row in the journal, not just the last one — a run's
 * spend is the whole node history, not its currently in-flight node.
 */
export const summarizeJournal = (
  rows: readonly JournalRow[],
  projectKey: string,
  mtimeMs: number,
  nowMs: number,
  /** Whether the run's process is alive, when its pidfile says; `none` falls back to the mtime rule. */
  alive: Option.Option<boolean> = Option.none()
): Option.Option<PsRow> => {
  const open = new Map<string, JournalRow>()
  for (const row of rows) {
    if (isStartRow(row)) open.set(`${row.node}#${row.attempt}`, row)
    else if (isEndRow(row)) open.delete(`${row.node}#${row.attempt}`)
  }
  const inFlight = [...open.values()]
  const last = inFlight[inFlight.length - 1]
  if (last === undefined) return Option.none()

  const first = rows[0]
  return Option.some({
    projectKey,
    ticket: last.ticket,
    graph: last.graph,
    runId: last.runId,
    node: last.node,
    attempt: last.attempt,
    nodeElapsedMs: nowMs - Date.parse(last.timestamp),
    runElapsedMs: nowMs - Date.parse(first.timestamp),
    stale: Option.match(alive, { onNone: () => nowMs - mtimeMs > STALE_THRESHOLD_MS, onSome: (isAlive) => !isAlive }),
    costUsd: rows.reduce((a, r) => a + endRowCostUsd(r), 0)
  })
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n)
const padL = (s: string | number, n: number): string => String(s).padStart(n)

/** The last three columns (two durations, then cost) right-align; everything else left-aligns. */
const RIGHT_ALIGNED = 3

/**
 * Column widths are measured from the data, never fixed up front — `projectKey` is a repo basename
 * plus an 8-hex-char disambiguating hash (`run-root.ts`'s `projectKey`), routinely past any width a
 * constant would choose, and a fixed pad misaligns every header the moment one field overflows.
 * Each column is as wide as its longest cell, header included,
 * joined by a two-space gutter; the borders span the measured width.
 */
export const renderTable = (rows: readonly PsRow[]): string => {
  if (rows.length === 0) return "no active runs"

  const header = ["project", "ticket", "graph", "node", "in node", "elapsed", "$ (est.)"]
  const cells = rows.map((r) => [
    r.projectKey,
    r.ticket,
    r.graph,
    `${r.node}#${r.attempt}`,
    fmtMs(r.nodeElapsedMs),
    fmtMs(r.runElapsedMs),
    usd(r.costUsd)
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (fields: readonly string[]): string =>
    fields
      .map((f, i) => (i >= header.length - RIGHT_ALIGNED ? padL(f, widths[i]) : pad(f, widths[i])))
      .join("  ")
      .trimEnd()
  const border = "-".repeat(widths.reduce((a, w) => a + w, 0) + (header.length - 1) * 2)

  const out: string[] = [line(header), border]
  for (const [i, r] of rows.entries()) out.push(line(cells[i]) + (r.stale ? "  stale?" : ""))
  out.push(border)
  return out.join("\n")
}

/**
 * One journal, best-effort: a path that isn't `<project>/<ticket>/<run>/journal.jsonl` (four
 * segments) or any I/O failure reading or stat'ing it drops the entry rather than failing the whole
 * scan — one foreign or unreadable path under the graph root must not hide every other run.
 */
const rowForJournal = (root: string, relPath: string, nowMs: number) =>
  Effect.gen(function* () {
    const segments = relPath.split("/")
    if (segments.length !== 4) return Option.none<PsRow>()
    const [projectKey] = segments

    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const fullPath = path.join(root, relPath)

    const text = yield* fs.readFileString(fullPath)
    const info = yield* fs.stat(fullPath)
    // No mtime is treated as maximally stale rather than special-cased: staleness only ever needs a
    // recency signal, and "unknown" is never more trustworthy than "old".
    const mtimeMs = Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() })
    // The pidfile decides when it exists; an unreadable or malformed one falls back to the mtime rule.
    const alive = yield* fs.readFileString(path.join(path.dirname(fullPath), PID_FILE)).pipe(
      Effect.map((pid) => (/^\d+$/.test(pid.trim()) ? Option.some(processAlive(Number(pid.trim()))) : Option.none<boolean>())),
      Effect.catch(() => Effect.succeed(Option.none<boolean>()))
    )

    return summarizeJournal(decodeJournalLines(text), projectKey, mtimeMs, nowMs, alive)
  }).pipe(Effect.catch(() => Effect.succeed(Option.none<PsRow>())))

/**
 * Every `journal.jsonl` under `root`, reduced to its active row when it has one. A missing root (no
 * run has ever happened on this machine) reads as no active runs, not a failure.
 */
export const scanRoot = Effect.fn("scanRoot")(function* (root: string, nowMs: number) {
  const fs = yield* FileSystem.FileSystem

  const entries = yield* fs.readDirectory(root, { recursive: true }).pipe(
    Effect.catch(() => Effect.succeed<readonly string[]>([]))
  )
  const journalPaths = entries.filter((entry) => entry.endsWith("journal.jsonl"))

  const found = yield* Effect.forEach(journalPaths, (rel) => rowForJournal(root, rel, nowMs), {
    concurrency: "unbounded"
  })
  return Arr.getSomes(found)
})

/**
 * Live rows only by default, stale ones behind `--stale`: a
 * corpse from a killed run is history, not status, and it buries the one row the watcher is
 * actually looking for. When stale rows are shown they sort below every live row. Hidden corpses
 * still leave a one-line count so "no active runs" is never mistaken for "no journals at all".
 *
 * With more than one visible run, a fleet-total line lands directly under the
 * bottom border, ahead of the stale-hidden count — this is the one place the footer is composed,
 * so both lines join here rather than either being spliced on by a caller. A single visible run
 * already carries its own total in the row; the fleet line would just repeat it.
 */
export const presentRows = (rows: readonly PsRow[], includeStale: boolean): string => {
  const sorted = [...rows].sort(
    (a, b) => Number(a.stale) - Number(b.stale) || b.runElapsedMs - a.runElapsedMs || a.ticket.localeCompare(b.ticket)
  )
  const visible = includeStale ? sorted : sorted.filter((r) => !r.stale)
  const hidden = sorted.length - visible.length

  const lines = [renderTable(visible)]
  if (visible.length > 1) {
    lines.push(`fleet total: ${usd(visible.reduce((a, r) => a + r.costUsd, 0))}`)
  }
  if (hidden > 0) {
    lines.push(`(${hidden} stale run${hidden === 1 ? "" : "s"} hidden — pass --stale to show)`)
  }
  return lines.join("\n")
}

const scanAndRender = (includeStale: boolean) =>
  Effect.gen(function* () {
    const { env, home } = yield* RunRootEnv
    const now = yield* DateTime.now
    const rows = yield* scanRoot(graphRoot(env, home), DateTime.toEpochMillis(now))
    return presentRows(rows, includeStale)
  })

/** Home + clear-to-end, not clear-whole-screen: repainting in place avoids the full-screen flash `watch(1)` has, and leaves no scrollback spam behind. */
const CLEAR = "\x1b[H\x1b[J"

/**
 * `mag ps`: every active run on this machine, oldest-started first (ticket breaks a tie). Watches
 * by default, repainting every `--interval` seconds until
 * interrupted; `--once` prints a single snapshot and exits, the shape a script or CI step wants.
 * Wired through `build-cli.ts`'s `"raw"` registry entry, not a GraphNode — see the module comment.
 */
export const psCommand = Command.make(
  "ps",
  {
    interval: Flag.integer("interval").pipe(
      Flag.withDefault(5),
      Flag.withDescription("Seconds between repaints while watching.")
    ),
    once: Flag.boolean("once").pipe(
      Flag.withDescription("Print one snapshot and exit instead of watching.")
    ),
    stale: Flag.boolean("stale").pipe(
      Flag.withDescription("Also show stale runs (journals silent past the threshold), sorted below live ones.")
    )
  },
  ({ interval, once, stale }) =>
    Effect.gen(function* () {
      if (once) {
        yield* Console.log(yield* scanAndRender(stale))
        return
      }
      // Not `Console.log`: `render.ts`'s `withStdoutRouting` buffers the capturing console and only
      // flushes on exit, and a watch loop's whole point is output before it exits. The raw stream is
      // correct here for the same reason `ps` is a raw registry entry: this output is for a human
      // watching, not a caller parsing.
      const repaint = Effect.gen(function* () {
        const table = yield* scanAndRender(stale)
        yield* Effect.sync(() => process.stdout.write(`${CLEAR}${table}\nevery ${interval}s\n`))
      })
      yield* Effect.repeat(repaint, Schedule.spaced(Duration.seconds(interval)))
    }).pipe(Effect.provide(platform))
).pipe(Command.withDescription("Watch every run currently active on this machine, read from the journals."))
