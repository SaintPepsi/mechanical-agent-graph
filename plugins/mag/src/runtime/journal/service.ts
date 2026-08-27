import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { matchesInput } from "mag/runtime/journal/canonical"
import { decodeJournalLines } from "mag/runtime/journal/decode"
import { carriesSuccess, type JournalRow, JournalRowSchema } from "mag/runtime/journal/row"

/**
 * The seam between deciding and writing. `journaled` (journaled.ts) decides what a row says;
 * this service decides where rows come from and where they go.
 */
export interface JournalService {
  /**
   * The success value a predecessor run recorded for `node` under this same input, still in its
   * recorded (encoded) form — the caller decodes it against the node's *current* success schema,
   * which is what turns a schema change into a fresh run instead of a wrong replay.
   */
  readonly recorded: (
    node: string,
    attempt: number,
    input: Option.Option<unknown>
  ) => Effect.Effect<Option.Option<unknown>>
  /** The next attempt number for `node` in this run, 1-based, consumed on read. */
  readonly attempt: (node: string) => Effect.Effect<number>
  readonly append: (row: JournalRow) => Effect.Effect<void, PlatformError>
}

/**
 * A `Context.Reference` whose default records nothing: `recorded` finds no predecessor, `append`
 * discards. A run that provides no journal runs exactly as it would with no journalling at all,
 * which is what lets `journaled` sit on every node without every call site having to opt in.
 */
export const Journal: Context.Reference<JournalService> = Context.Reference<JournalService>(
  "mag/runtime/Journal",
  {
    defaultValue: () => ({
      recorded: () => Effect.succeedNone,
      attempt: () => Effect.succeed(1),
      append: () => Effect.void
    })
  }
)

export interface JournalPaths {
  /** Where this run appends: the run directory's `journal.jsonl`, beside the record copies and
   *  numbered artifacts the run's nodes also write there (`run-root.ts`). */
  readonly path: string
  /** The graph this run executes. A predecessor row stamped with a different graph never replays. */
  readonly graph: string
  /** The journal a resume replays from. `None` for a first run. */
  readonly predecessor: Option.Option<string>
}

const recordedInput = (row: JournalRow): Option.Option<unknown> =>
  Object.hasOwn(row, "input") ? Option.some(row.input) : Option.none()

/**
 * The predecessor's rows, decoded through `journal/decode.ts`'s shared `decodeJournalLines` — the
 * one home for a decode this function, `ps.ts` and `usage-report.ts` would otherwise each carry
 * their own copy of. A line that does not decode is skipped rather than fatal: the last line of a
 * journal whose run was killed mid-append is a partial line, and one torn write must not cost a
 * resume every row before it. A missing predecessor file reads as no rows at all.
 */
const readRows = (
  fs: FileSystem.FileSystem,
  predecessor: Option.Option<string>
): Effect.Effect<readonly JournalRow[], PlatformError> =>
  Option.match(predecessor, {
    onNone: () => Effect.succeed([]),
    onSome: (path) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(path))) return []
        return decodeJournalLines(yield* fs.readFileString(path))
      })
  })

/**
 * The row this invocation replays, keyed by position: invocation N of a node replays the row the
 * predecessor recorded at attempt N. Matching by node + input alone was the bug this replaces — a
 * node invoked twice with the same input got the LAST row's success in BOTH positions, so a
 * nondeterministic node that recorded `A` then `B` resumed as `B, B`.
 *
 * When attempt N's row is not a replayable success (it failed, or its success would not encode),
 * the scan moves FORWARD to the next matching `ok` — a node that failed and then succeeded on a
 * later same-input attempt is a node that succeeded, and that later success replays in place of the
 * failure. Never backward: an earlier attempt's success already belongs to an earlier invocation.
 *
 * A `replayed: true` row counts like any `ok`: a resume of a resume replays what the run before it
 * replayed, so a chain of resumes converges rather than re-running the whole prefix at every link.
 */
const replayableSuccess = (
  rows: readonly JournalRow[],
  node: string,
  attempt: number,
  input: Option.Option<unknown>
): Option.Option<unknown> => {
  const matches = matchesInput(input)
  const candidates = rows
    .filter(carriesSuccess)
    .filter((row) => row.node === node && matches(recordedInput(row)))
  const row = candidates.find((candidate) => candidate.attempt === attempt)
    ?? candidates.filter((candidate) => candidate.attempt > attempt).sort((a, b) => a.attempt - b.attempt)[0]
  return Option.fromUndefinedOr(row).pipe(Option.map((found) => found.success))
}

/**
 * The live journal's own construction, as a plain Effect rather than a Layer: `run-layers.ts`'s
 * resume path needs the built `JournalService` in hand to append the run's own `resume-run` record
 * before handing that same instance to the pipeline, so the predecessor's rows are read once, not
 * twice.
 *
 * Reads the predecessor's rows once, at build time, so a resume pays one file read for the whole run
 * rather than one per node. Appends go through Effect's `FileSystem` in append mode — unlike
 * `trace/file-sink.ts`, which uses raw `node:fs` because a trace sink is a plain callback with no
 * Effect to run in; a journal append is an ordinary effect inside `run`.
 *
 * The run directory is created here, once, so the first `append` of a run has somewhere to land.
 */
export const makeJournal = (
  paths: JournalPaths
): Effect.Effect<JournalService, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // Rows from another graph's run are invisible here: resume's own selection (`resume.ts`) picks
    // a predecessor per graph, but the predecessor's own journal can still hold rows from a graph
    // it borrowed or was borrowed by — this filter is the guard that keeps a wrong pick from
    // handing this graph a value some other graph computed.
    const previous = (yield* readRows(fs, paths.predecessor)).filter((row) => row.graph === paths.graph)
    const attempts = yield* Ref.make(new Map<string, number>())
    yield* fs.makeDirectory(path.dirname(paths.path), { recursive: true })
    const encode = Schema.encodeSync(JournalRowSchema)

    return {
      recorded: (node, attempt, input) => Effect.sync(() => replayableSuccess(previous, node, attempt, input)),
      attempt: (node) =>
        Ref.modify(attempts, (counts) => {
          const next = (counts.get(node) ?? 0) + 1
          return [next, new Map(counts).set(node, next)]
        }),
      append: (row) => fs.writeFileString(paths.path, `${JSON.stringify(encode(row))}\n`, { flag: "a" })
    }
  })

export const journalLayer = (
  paths: JournalPaths
): Layer.Layer<never, PlatformError, FileSystem.FileSystem | Path.Path> => Layer.effect(Journal, makeJournal(paths))
