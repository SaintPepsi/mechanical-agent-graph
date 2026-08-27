import { Predicate } from "effect"
import { isEndRow, isStartRow, type JournalRow } from "mag/runtime/journal/row"
import { REVIEW_WINDOW_SCHEMA, type ReviewPass, type ReviewWindow, type Verdict } from "mag/runtime/review-window"

/**
 * The pure selection core: everything here is a function over decoded rows, filenames and first
 * lines, with all I/O left to `graph-node.ts`.
 */

/** Outcome `ok` is `clean`, tag `REVIEW_BLOCKED` is `blocked`, tag `REVIEW_DISPUTE_REJECTED` is `dispute-rejected`. Every other outcome/tag pair burned no judgment and is not a pass at all. */
const verdictFor = (outcome: string, tag: string | undefined): Verdict | undefined => {
  if (outcome === "ok") return "clean"
  if (tag === "REVIEW_BLOCKED") return "blocked"
  if (tag === "REVIEW_DISPUTE_REJECTED") return "dispute-rejected"
  return undefined
}

/** One run's decoded journal, plus the two facts the rows themselves don't carry: which project it belongs to, and the run directory its own artifacts live in. */
export interface RunJournal {
  readonly projectKey: string
  readonly runRoot: string
  readonly rows: readonly JournalRow[]
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) ? (value as Record<string, unknown>) : undefined

/**
 * Every review-diff pass one run's journal records, with
 * everything derivable from journal rows alone. `findingsPath` is left `null` here on purpose: it
 * names an artifact outside this run's own journal, resolved later by {@link indexArtifacts} once
 * `selectWindow` has narrowed which runs are even worth listing — only the selected runs
 * get their directories listed.
 */
export const reviewPasses = (run: RunJournal): readonly ReviewPass[] => {
  const { projectKey, rows, runRoot } = run

  // A start row's own timestamp, keyed by node+attempt — the same pairing `usage-report.ts` pairs
  // start/end rows by, since every row here already shares one runId.
  const starts = new Map<string, string>()
  for (const row of rows) {
    if (isStartRow(row)) starts.set(`${row.node}#${row.attempt}`, row.timestamp)
  }

  // A fresh build success, keyed by the tree it left. A review row's own `headSha` names the tree
  // it is gating, and a build row's `success.headSha` is the tree it produced — the two meet here,
  // no extra disk read required, since both already live in the same journal.
  const buildSummaryByHeadSha = new Map<string, string>()
  for (const row of rows) {
    if (!isEndRow(row) || row.node !== "build" || row.outcome !== "ok") continue
    const success = asRecord(row.success)
    const headSha = success?.["headSha"]
    const summaryPath = success?.["summaryPath"]
    if (Predicate.isString(headSha) && Predicate.isString(summaryPath)) {
      buildSummaryByHeadSha.set(headSha, summaryPath)
    }
  }

  // The run's own design, if it ran one. At most one per run in every graph carrying this node.
  let designPath: string | null = null
  for (const row of rows) {
    if (!isEndRow(row) || row.node !== "design" || row.outcome !== "ok") continue
    const path = asRecord(row.success)?.["designPath"]
    if (Predicate.isString(path)) {
      designPath = path
      break
    }
  }

  const passes: ReviewPass[] = []
  for (const row of rows) {
    if (!isEndRow(row) || row.node !== "review-diff") continue
    const verdict = verdictFor(row.outcome, row.tag)
    if (verdict === undefined) continue

    const input = asRecord(row.input) ?? {}
    const headSha = input["headSha"]
    // An unfit row: a review-diff end row with no recorded `headSha` answers nothing this schema
    // needs, so it is dropped rather than forced into a `ReviewPass` it cannot honestly fill.
    if (!Predicate.isString(headSha)) continue

    const success = row.outcome === "ok" ? asRecord(row.success) : undefined
    const rawSessions = success?.["sessions"]
    const sessions = Array.isArray(rawSessions) ? rawSessions.filter(Predicate.isString) : []
    const disputePath = input["disputePath"]
    const model = input["model"]
    const agent = input["agent"]
    const graph = row.graph

    passes.push({
      id: `${row.ticket}/${row.runId}#${row.attempt}`,
      projectKey,
      ticket: row.ticket,
      graph,
      runId: row.runId,
      runRoot,
      pass: row.attempt,
      verdict,
      ...(row.tag === undefined ? {} : { tag: row.tag }),
      headSha,
      startedAt: starts.get(`review-diff#${row.attempt}`) ?? row.timestamp,
      endedAt: row.timestamp,
      ...(Predicate.isString(model) ? { reviewModel: model } : {}),
      ...(Predicate.isString(agent) ? { reviewAgent: agent } : {}),
      findingsPath: null,
      buildSummaryPath: buildSummaryByHeadSha.get(headSha) ?? null,
      designPath,
      disputePath: Predicate.isString(disputePath) ? disputePath : null,
      sessions
    })
  }
  return passes
}

export interface WindowSelection {
  readonly selected: readonly ReviewPass[]
  readonly through: string
}

/**
 * The oldest `size` passes ending after `since`, so successive
 * analyses tile history forward instead of skipping or re-covering it. `through` is the last
 * selected pass's own `endedAt`, the next call's watermark. Fewer than `size` eligible passes is
 * `undefined`, not an empty or partial selection — `gather-reviews` turns that into `WindowNotFull`.
 */
export const selectWindow = (
  passes: readonly ReviewPass[],
  since: string,
  size: number
): WindowSelection | undefined => {
  const eligible = passes
    .filter((pass) => pass.endedAt > since)
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id))
  if (eligible.length < size) return undefined

  const selected = eligible.slice(0, size)
  return { selected, through: selected[selected.length - 1]!.endedAt }
}

export interface ReviewArtifact {
  readonly path: string
  readonly sha: string
}

/** `review-diff`'s own first line, `Reviewed at <sha>` — produced by `renderFindings` in `review-diff/graph-node.ts`. */
const REVIEWED_AT = /^Reviewed at (\S+)/

export const shaFromFindingsFirstLine = (firstLine: string): string | undefined => REVIEWED_AT.exec(firstLine)?.[1]

/**
 * Matches `findingsPath` by the sha each `review-diff-*.md` states about itself, never by
 * position — a row `reviewPasses` dropped (a pass that died before writing, e.g.
 * `REVIEW_HEAD_MOVED`) would otherwise shift every later filename out of step with its pass.
 * `artifacts` must already be in write order (ascending `review-diff-<N>.md`, {@link reviewDiffFilenamesInOrder});
 * two passes sharing a headSha (an adjudicating dispute pass re-reviewing the same tree)
 * resolve FIFO, the same order they were written and journaled in.
 */
export const indexArtifacts = (
  passes: readonly Pick<ReviewPass, "id" | "headSha">[],
  artifacts: readonly ReviewArtifact[]
): ReadonlyMap<string, string> => {
  const queues = new Map<string, string[]>()
  for (const artifact of artifacts) {
    const queue = queues.get(artifact.sha)
    if (queue === undefined) queues.set(artifact.sha, [artifact.path])
    else queue.push(artifact.path)
  }

  const found = new Map<string, string>()
  for (const pass of passes) {
    const path = queues.get(pass.headSha)?.shift()
    if (path !== undefined) found.set(pass.id, path)
  }
  return found
}

const REVIEW_DIFF_FILENAME = /^review-diff-(\d+)\.md$/

/** A directory listing, reduced to its `review-diff-*.md` names in the order `writeArtifact` wrote them. */
export const reviewDiffFilenamesInOrder = (names: readonly string[]): readonly string[] =>
  names
    .filter((name) => REVIEW_DIFF_FILENAME.test(name))
    .sort((a, b) => Number(REVIEW_DIFF_FILENAME.exec(a)![1]) - Number(REVIEW_DIFF_FILENAME.exec(b)![1]))

/** `review-patterns-*.md`'s own first line, `Analysed through <ISO>` — the watermark this report states about itself. */
const ANALYSED_THROUGH = /^Analysed through (\S+)/

/**
 * The watermark is the previous report, not a state file: the maximum
 * `Analysed through <ISO>` across every prior report's first line, or `epoch` when there are none
 * (or none parse) — the floor below which this graph has never been asked to look.
 */
export const watermarkFrom = (reportFirstLines: readonly string[], epoch: string): string =>
  reportFirstLines
    .map((line) => ANALYSED_THROUGH.exec(line)?.[1])
    .filter((iso): iso is string => iso !== undefined)
    .reduce((max, iso) => (iso > max ? iso : max), epoch)

export interface ManifestParts {
  readonly size: number
  readonly since: string
  readonly through: string
  readonly transcriptsRoot: string
  readonly passes: readonly ReviewPass[]
}

/** The `ReviewWindow` shape, assembled from what `gather-reviews` already computed — the one place `REVIEW_WINDOW_SCHEMA` gets stamped onto a manifest. */
export const buildManifest = (parts: ManifestParts): ReviewWindow => ({
  schema: REVIEW_WINDOW_SCHEMA,
  size: parts.size,
  since: parts.since,
  through: parts.through,
  transcriptsRoot: parts.transcriptsRoot,
  passes: parts.passes
})
