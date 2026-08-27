import { type Exit, Option, Schema } from "effect"
import type { RunInfoService } from "mag/runtime/run-info"
import { OutcomeSchema } from "mag/runtime/trace/event"
import { outcomeOf } from "mag/runtime/trace/outcome"

/**
 * Two entries per node run, appended to `journal.jsonl`. The journal answers "what has this
 * run completed, and what is it doing right now"; the trace stream answers "what happened inside
 * this process" (`trace/event.ts`). Both classify an `Exit` the same way — `Outcome` and `outcomeOf`
 * are imported from `trace/`, so the two files can never disagree about what "died" means — and each
 * owns its own format.
 *
 * Entering and exiting a node are two separate entries, not one row carrying
 * `startedAt`/`endedAt`. A start entry with no matching end entry is then a precise statement —
 * this node was running when the run stopped recording — which a single-row journal could never
 * say about a process killed mid-node.
 *
 * `schema` pins the row shape, and readers accept that literal and nothing else: a journal written
 * under any other version is unreadable rather than half-understood. `pipelineSha` carries the
 * executing plugin checkout's own HEAD, beside the target checkout's `sha`, so a run's numbers can
 * be sliced by which pipeline version produced them.
 */
export const JOURNAL_SCHEMA = "graph/journal@3" as const

/** Fields every entry shares. */
const StampFields = {
  runId: Schema.String,
  ticket: Schema.String,
  graph: Schema.String,
  repoRoot: Schema.String,
  sha: Schema.String,
  pipelineSha: Schema.String,
  node: Schema.String,
  /** 1-based, per node, per run. A node re-entered by a loop appends a second start/end pair. */
  attempt: Schema.Int
}

/**
 * The entered entry: written before the node's work begins. `input` rides on it too, for forensics
 * — what was the in-flight node working on — even though nothing has replayed from it yet.
 */
const JournalStartRowSchema = Schema.Struct({
  schema: Schema.Literal(JOURNAL_SCHEMA),
  ...StampFields,
  event: Schema.Literal("start"),
  timestamp: Schema.String,
  input: Schema.optional(Schema.Unknown)
})

export type JournalStartRow = typeof JournalStartRowSchema.Type

/**
 * The exited entry: written on all four outcomes. `input` repeats here too, so `recorded()`'s
 * predecessor lookup stays self-contained on this one line rather than having to also find the
 * matching start entry just to read what it ran against.
 */
const JournalEndRowSchema = Schema.Struct({
  schema: Schema.Literal(JOURNAL_SCHEMA),
  ...StampFields,
  event: Schema.Literal("end"),
  timestamp: Schema.String,
  /** `true` when the success value came from the predecessor's journal instead of from `run`. */
  replayed: Schema.Boolean,
  input: Schema.optional(Schema.Unknown),
  outcome: OutcomeSchema,
  /** Present on `fail` and `die` when the failure or defect carried a string `_tag`. */
  tag: Schema.optional(Schema.String),
  /** Best-effort encoded, present only on `ok`. An `ok` row without it re-runs the node. */
  success: Schema.optional(Schema.Unknown)
})

export type JournalEndRow = typeof JournalEndRowSchema.Type

/**
 * A journal row is one of two shapes: the start entry a node's about-to-run lands, or the end entry
 * its outcome lands. A reader that only wants "what did this node run finish with, and when" decodes
 * either and asks `isEndRow` — see `usage-report.ts`, which pairs entries back into that question.
 */
export const JournalRowSchema = Schema.Union([JournalStartRowSchema, JournalEndRowSchema])

export type JournalRow = typeof JournalRowSchema.Type

/** The entered entry. */
export const isStartRow = (row: JournalRow): row is JournalStartRow => row.event === "start"

/** The exited entry. */
export const isEndRow = (row: JournalRow): row is JournalEndRow => row.event === "end"

/**
 * A row is replayable when it recorded a success that is actually there. The `row is` guard is also
 * what excludes a start entry from ever replaying: only an end entry carries `outcome`
 * at all, so a predecessor's start-without-end fails this check and the node it names re-runs fresh.
 *
 * Exported so "a row that can replay" has one definition, shared by replay itself
 * (`service.ts`'s `replayableSuccess`) and by resume's own predecessor ranking (`resume.ts`'s
 * `mostReplayable`), rather than one copy per reader.
 */
export const carriesSuccess = (row: JournalRow): row is JournalEndRow =>
  row.event === "end" && row.outcome === "ok" && Object.hasOwn(row, "success") && row.success !== undefined

interface StampParts {
  readonly run: RunInfoService
  readonly node: string
  readonly attempt: number
}

/** The run-scoped half every entry shares, plus the fields both builders always set. */
const stamp = (parts: StampParts) => ({
  schema: JOURNAL_SCHEMA,
  runId: parts.run.runId,
  ticket: parts.run.ticket,
  graph: parts.run.graph,
  repoRoot: parts.run.repoRoot,
  sha: parts.run.sha,
  pipelineSha: parts.run.pipelineSha,
  node: parts.node,
  attempt: parts.attempt
})

export interface StartParts extends StampParts {
  readonly input: Option.Option<unknown>
  readonly timestamp: string
}

/** The node is about to run (fresh) or about to be answered from a predecessor's journal (replay) — either way, this lands before that happens. */
export const startRow = (parts: StartParts): JournalStartRow => ({
  ...stamp(parts),
  event: "start",
  timestamp: parts.timestamp,
  ...(Option.isSome(parts.input) ? { input: parts.input.value } : {})
})

export interface RanEndParts extends StampParts {
  readonly input: Option.Option<unknown>
  readonly timestamp: string
  readonly exit: Exit.Exit<unknown, unknown>
  /** Best-effort encoded success. Ignored unless `exit` succeeded. */
  readonly success: Option.Option<unknown>
}

/** The node ran. `outcome`/`tag` come from `trace/outcome.ts`; `success` rides along only on `ok`. */
export const ranEndRow = (parts: RanEndParts): JournalEndRow => ({
  ...stamp(parts),
  event: "end",
  timestamp: parts.timestamp,
  replayed: false,
  ...outcomeOf(parts.exit),
  ...(Option.isSome(parts.input) ? { input: parts.input.value } : {}),
  ...(Option.isSome(parts.success) ? { success: parts.success.value } : {})
})

export interface ReplayedEndParts extends StampParts {
  readonly input: Option.Option<unknown>
  readonly timestamp: string
  readonly success: unknown
}

/**
 * The node's success came from the predecessor's journal. The pair is still written, and still
 * stamped: a resumed run's journal is complete on its own, so counting completed runs over one
 * journal answers "what did this run do" and filtering to `replayed: false` answers "what did it
 * pay for".
 */
export const replayedEndRow = (parts: ReplayedEndParts): JournalEndRow => ({
  ...stamp(parts),
  event: "end",
  timestamp: parts.timestamp,
  replayed: true,
  outcome: "ok",
  ...(Option.isSome(parts.input) ? { input: parts.input.value } : {}),
  success: parts.success
})
