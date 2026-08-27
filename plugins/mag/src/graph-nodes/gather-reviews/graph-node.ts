import { Effect, FileSystem, Schema } from "effect"
import { WindowNotFull, WindowRunRootMissing, WindowWriteFailed } from "mag/graph-nodes/gather-reviews/errors"
import {
  buildManifest,
  indexArtifacts,
  reviewDiffFilenamesInOrder,
  reviewPasses,
  selectWindow,
  shaFromFindingsFirstLine,
  watermarkFrom
} from "mag/graph-nodes/gather-reviews/reviews"
import { decodeJournalLines } from "mag/runtime/journal/decode"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { ReviewWindowSchema } from "mag/runtime/review-window"
import { RunInfo } from "mag/runtime/run-info"
import { RunRootEnv } from "mag/runtime/run-layers"
import { graphRoot, transcriptsRoot } from "mag/runtime/run-root"

/** `ps.ts`'s own rule: a journal.jsonl path under the graph root names a run only when its relative path has exactly four segments, `<projectKey>/<ticket>/<runId>/journal.jsonl`. Anything else is foreign. */
const isRunJournalPath = (relPath: string): boolean => relPath.split("/").length === 4

const REVIEW_PATTERNS_REPORT = /review-patterns-\d+\.md$/

/**
 * Every journal under the graph root, decoded best-effort and
 * reduced to its review passes. An unreadable or foreign journal drops that run rather than failing
 * the whole scan (`ps.ts`'s own precedent) — one bad run must not hide every other run's evidence.
 */
const scanRuns = (fs: FileSystem.FileSystem, root: string, journalPaths: readonly string[]) =>
  Effect.forEach(
    journalPaths,
    (relPath) =>
      Effect.gen(function* () {
        const runRoot = `${root}/${relPath.slice(0, -"/journal.jsonl".length)}`
        const text = yield* fs.readFileString(`${root}/${relPath}`)
        return { projectKey: relPath.split("/")[0]!, runRoot, rows: decodeJournalLines(text) }
      }).pipe(Effect.catch(() => Effect.succeed(undefined))),
    { concurrency: "unbounded" }
  ).pipe(Effect.map((runs) => runs.filter((run): run is NonNullable<typeof run> => run !== undefined)))

/**
 * Only the selected runs' directories get listed, and only their
 * own `review-diff-*.md` first lines get read. One run root's own artifacts, indexed by headSha for
 * just that run's own selected passes — `indexArtifacts` never sees another run's files, since a
 * headSha match across two unrelated runs would be a coincidence, not a pairing.
 */
const findingsForRun = (fs: FileSystem.FileSystem, runRoot: string, passes: readonly { readonly id: string; readonly headSha: string }[]) =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(runRoot).pipe(Effect.catch(() => Effect.succeed<readonly string[]>([])))
    const ordered = reviewDiffFilenamesInOrder(names)
    const artifacts = yield* Effect.forEach(ordered, (name) =>
      fs.readFileString(`${runRoot}/${name}`).pipe(
        Effect.map((text) => {
          const sha = shaFromFindingsFirstLine(text.split("\n")[0] ?? "")
          return sha === undefined ? undefined : { path: `${runRoot}/${name}`, sha }
        }),
        Effect.catch(() => Effect.succeed(undefined))
      ))
    return indexArtifacts(passes, artifacts.filter((artifact): artifact is { path: string; sha: string } => artifact !== undefined))
  })

/**
 * The watermark is the previous report, not a state file: every prior
 * `review-patterns-*.md` under the graph root, reduced to its own first line — `Analysed through
 * <ISO>` states which tree of history that report already covers, the same idiom `review-diff`'s
 * `Reviewed at <headSha>` uses for what its own verdict is about.
 */
const priorReportFirstLines = (fs: FileSystem.FileSystem, root: string, entries: readonly string[]) =>
  Effect.forEach(
    entries.filter((entry) => REVIEW_PATTERNS_REPORT.test(entry)),
    (relPath) =>
      fs.readFileString(`${root}/${relPath}`).pipe(
        Effect.map((text) => text.split("\n")[0] ?? ""),
        Effect.catch(() => Effect.succeed(""))
      ),
    { concurrency: "unbounded" }
  )

/**
 * Finds the next unanalysed window of review passes and materialises it as `window.json`.
 * Mechanical throughout — no `Shell`, no `ClaudeAgent` — this node cannot spend a
 * token; a window short of `size` is {@link WindowNotFull}, reached before any dispatch, so invoking
 * this node with nothing to do costs one recursive directory read.
 *
 * The window's own artifact-selection algorithm (which rows count as a pass, which findings file
 * pairs with which, where the watermark comes from) is entirely in `reviews.ts`'s pure core; this
 * module is only the I/O that feeds it and the write that follows it.
 */
export const gatherReviews = make({
  name: "gather-reviews",
  description: "Find the next unanalysed window of review passes and materialize it as window.json.",
  input: Schema.Struct({
    /** How many review passes make a window before it triggers analysis. */
    size: Schema.Natural,
    /** The floor for the first-ever window, before any report exists to derive a watermark from. */
    epoch: Schema.String
  }),
  success: Schema.Struct({
    manifestPath: Schema.String,
    passes: Schema.Int,
    runs: Schema.Int,
    since: Schema.String,
    through: Schema.String
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new WindowRunRootMissing())

      const fs = yield* FileSystem.FileSystem
      const rootEnv = yield* RunRootEnv
      const graphRootPath = graphRoot(rootEnv.env, rootEnv.home)

      // A missing graph root (no run has ever happened on this machine) reads as an empty scan, not
      // a failure — the same "no active runs" reading `ps.ts`'s `scanRoot` gives it.
      const entries = yield* fs.readDirectory(graphRootPath, { recursive: true }).pipe(
        Effect.catch(() => Effect.succeed<readonly string[]>([]))
      )
      const journalPaths = entries.filter((entry) => entry.endsWith("journal.jsonl") && isRunJournalPath(entry))

      const runs = yield* scanRuns(fs, graphRootPath, journalPaths)
      const allPasses = runs.flatMap((run) => reviewPasses(run))

      const reportLines = yield* priorReportFirstLines(fs, graphRootPath, entries)
      const since = watermarkFrom(reportLines, input.epoch)

      const window = selectWindow(allPasses, since, input.size)
      if (window === undefined) {
        const eligible = allPasses.filter((pass) => pass.endedAt > since).length
        return yield* Effect.fail(new WindowNotFull({ passes: eligible, size: input.size, since }))
      }

      const runRoots = [...new Set(window.selected.map((pass) => pass.runRoot))]
      const findingsByRun = yield* Effect.forEach(
        runRoots,
        (runRoot) =>
          findingsForRun(fs, runRoot, window.selected.filter((pass) => pass.runRoot === runRoot)).pipe(
            Effect.map((found) => [...found])
          ),
        { concurrency: "unbounded" }
      )
      const findingsById = new Map(findingsByRun.flat())

      const passesWithFindings = window.selected.map((pass) => ({
        ...pass,
        findingsPath: findingsById.get(pass.id) ?? null
      }))

      const manifest = buildManifest({
        size: input.size,
        since,
        through: window.through,
        transcriptsRoot: transcriptsRoot(rootEnv.env, rootEnv.home),
        passes: passesWithFindings
      })
      const encoded = Schema.encodeSync(ReviewWindowSchema)(manifest)

      const manifestPath = `${runInfo.runRoot}/window.json`
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(runInfo.runRoot, { recursive: true })
        yield* fs.writeFileString(manifestPath, JSON.stringify(encoded, null, 2))
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(new WindowWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) }))
        )
      )

      return {
        manifestPath,
        passes: passesWithFindings.length,
        runs: new Set(passesWithFindings.map((pass) => pass.runId)).size,
        since,
        through: window.through
      }
    }).pipe(Effect.provide(platform))
})
