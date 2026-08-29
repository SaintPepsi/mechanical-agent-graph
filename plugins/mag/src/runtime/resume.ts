import { Context, Data, Effect, FileSystem, Option, Predicate } from "effect"
import { decodeJournalLines } from "mag/runtime/journal/decode"
import { carriesSuccess, type JournalRow } from "mag/runtime/journal/row"
import { platform } from "mag/runtime/platform"

/**
 * Chooses which prior run of a ticket a resume continues. `run-layers.ts` otherwise hardcodes the
 * predecessor slot to `Option.none()`: a wrong selection replays another run's values, so the
 * selection earns its code only once resume work actually exercises it.
 *
 * A shared reader, not a service: `run-layers.ts` calls it inside `runScopedLayers`, before the
 * journal layer (and `RunScoped`) exist, and the `resume-run` node calls it standalone from the CLI —
 * both read the same ticket directory the same best-effort way (`ps.ts`'s own posture). Takes the
 * ticket directory as composed data and never imports `run-layers.ts`, so the two runtime modules
 * stay acyclic.
 */

/** The node name a resume's own record lands under — a constant so the ranking, the record and the node share one spelling. */
export const RESUME_NODE = "resume-run"

/**
 * Stated once so it can travel: read by the ranking below, written into every resumed run's own
 * `resume-run` record (`run-layers.ts`), and returned verbatim by the `resume-run` node — the
 * record needs the same words at every site.
 */
export const RESUME_RULE =
  "the prior run of this ticket with the most replayable nodes for this graph, its own resume record excluded, newest run id on ties"

/**
 * Whether a recorded success would replay today: `journaled.ts` replays a row only after it decodes
 * against the node's *current* success schema, so the ranking below must count with the same
 * question or it picks a run whose rows are all stale (the GH-332 resume that chose a pre-`ticketPath`
 * run over last night's, replayed nothing and redid the whole design). The composition root provides
 * the registry-backed probe (`run-cli.ts`); the default counts every success, the runtime's own
 * schemas being unavailable here without an import cycle.
 */
export const ReplayProbe = Context.Reference<(node: string, success: unknown) => boolean>("mag/runtime/ReplayProbe", {
  defaultValue: () => () => true
})

export interface ResumeSelection {
  readonly predecessorRunId: string
  readonly journalPath: string
  /** Distinct replayable nodes, `mostReplayable`'s ranking measure — never a row count (a looped node's retries collapse to one). */
  readonly replayable: number
  /** The predecessor's own recorded work root, present only when the predecessor was itself a resume. */
  readonly workRoot: Option.Option<string>
  readonly rule: string
}

/** A resume was requested but no sibling run has a single replayable node for this graph. `inspected` is how many sibling run directories were seen, so "storage told us nothing" and "nothing is eligible" stay distinguishable. */
export class ResumeWithoutPredecessor extends Data.TaggedError("RESUME_WITHOUT_PREDECESSOR")<{
  readonly ticket: string
  readonly graph: string
  readonly inspected: number
}> {}

interface RunRows {
  readonly runId: string
  readonly rows: readonly JournalRow[]
}

interface RankedRun extends RunRows {
  readonly replayable: number
}

/**
 * The pure core, exported for its own test: the prior run of this ticket with the most replayable
 * DISTINCT NODES for `graph`, its own `resume-run` record excluded (that row is this run's history
 * of resuming, not work the graph itself did), newest run id on ties — run ids sort by start time
 * (`trace/layer.ts`'s `stamp`), so a lexicographic compare is a recency compare.
 *
 * Picking the newest run directory instead of the most-replayable one has a real failure mode: a
 * resumed run re-writes its replayed rows into its own journal as it goes, so a resume killed early
 * has a genuinely shorter ledger than the run it continued, and "newest directory name" would chain
 * the next resume off that half-finished attempt. Most-replayable is what survives that failure mode.
 *
 * Counted by node, not by row: a node re-entered by a loop appends a second start/end pair
 * (`row.ts`'s `attempt`), so a row count would let a retry-heavy run with fewer distinct nodes outrank a
 * longer single-pass run that actually replays more work.
 */
export const mostReplayable = (
  runs: readonly RunRows[],
  graph: string,
  replays: (node: string, success: unknown) => boolean = () => true
): Option.Option<RankedRun> => {
  let best: RankedRun | undefined
  for (const run of runs) {
    const replayable = new Set(
      run.rows
        .filter((row) => row.graph === graph && row.node !== RESUME_NODE && carriesSuccess(row) && replays(row.node, row.success))
        .map((row) => row.node)
    ).size
    if (replayable === 0) continue
    if (best === undefined || replayable > best.replayable || (replayable === best.replayable && run.runId > best.runId)) {
      best = { ...run, replayable }
    }
  }
  return Option.fromUndefinedOr(best)
}

/** The chosen run's own recorded work root, when it was itself a resume — `None` for a run that never carried a `resume-run` record. */
const workRootOf = (rows: readonly JournalRow[]): Option.Option<string> => {
  const success = rows.filter(carriesSuccess).find((row) => row.node === RESUME_NODE)?.success
  if (!Predicate.isObject(success)) return Option.none()
  const workRoot = (success as Record<string, unknown>)["workRoot"]
  return Predicate.isString(workRoot) ? Option.some(workRoot) : Option.none()
}

/** One sibling's journal, best-effort: a missing or unreadable file reads as no rows at all — `ps.ts`'s own posture, applied to a directory of run directories instead of a directory of journals. */
const readSiblingRows = (fs: FileSystem.FileSystem, journalPath: string) =>
  fs.readFileString(journalPath).pipe(
    Effect.map(decodeJournalLines),
    Effect.catch(() => Effect.succeed<readonly JournalRow[]>([]))
  )

/**
 * `ticketDir`'s own subdirectories, each named for the run id it holds (`run-root.ts`'s
 * `runDirFor`): every prior run of this ticket, decoded best-effort and ranked. A missing ticket
 * directory (no prior run of this ticket exists) reads as no siblings rather than failing — the
 * scan that follows then fails `ResumeWithoutPredecessor` with an honest `inspected: 0`.
 */
export const selectPredecessor = Effect.fn("selectPredecessor")(function* (options: {
  readonly ticketDir: string
  readonly graph: string
}) {
  const fs = yield* FileSystem.FileSystem
  const ticket = options.ticketDir.split("/").pop() ?? options.ticketDir

  const entries = yield* fs.readDirectory(options.ticketDir).pipe(
    Effect.catch(() => Effect.succeed<readonly string[]>([]))
  )

  const runs = yield* Effect.forEach(
    entries,
    (runId) => readSiblingRows(fs, `${options.ticketDir}/${runId}/journal.jsonl`).pipe(Effect.map((rows) => ({ runId, rows }))),
    { concurrency: "unbounded" }
  )

  const chosen = mostReplayable(runs, options.graph, yield* ReplayProbe)
  if (Option.isNone(chosen)) {
    return yield* Effect.fail(new ResumeWithoutPredecessor({ ticket, graph: options.graph, inspected: entries.length }))
  }

  return {
    predecessorRunId: chosen.value.runId,
    journalPath: `${options.ticketDir}/${chosen.value.runId}/journal.jsonl`,
    replayable: chosen.value.replayable,
    workRoot: workRootOf(chosen.value.rows),
    rule: RESUME_RULE
  } satisfies ResumeSelection
}, Effect.provide(platform))
