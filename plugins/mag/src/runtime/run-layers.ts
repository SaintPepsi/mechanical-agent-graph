import { homedir } from "node:os"
import { Context, Data, Effect, Exit, FileSystem, Layer, Option } from "effect"
import { gitRead } from "mag/runtime/git"
import { nowIso } from "mag/runtime/journal/journaled"
import { Journal, journalLayer, makeJournal } from "mag/runtime/journal/service"
import { ranEndRow, startRow } from "mag/runtime/journal/row"
import { platform } from "mag/runtime/platform"
import { RESUME_NODE, selectPredecessor } from "mag/runtime/resume"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { PIPELINE_ROOT, runInfoValues } from "mag/runtime/run-info-layer"
import { type Env, isSafeSegment, journalPathFor, runDirFor, ticketDirFor } from "mag/runtime/run-root"
import { Shell } from "mag/runtime/shell"
import { RunId } from "mag/runtime/trace/layer"
import { worktreeDirFor } from "mag/runtime/work-root"

/**
 * The run-scoped half of the composition root. `main` owns the process-scoped half — one
 * run id, minted by `runIdLayer` and exposed through `tracingLayer` (`trace/layer.ts`) — but the
 * ticket id exists only after the command parses its flags, so the layers that need it (the
 * journal, the run info) cannot be built at `main`. They are built here instead, at the point in a
 * graph's `run` where the ticket is known, from the same already-minted run id: one id, stamped on
 * every journal row and every trace span alike.
 */

/** A ticket or run id that cannot be a path segment. The run fails before any file is written. */
export class UnsafePathSegment extends Data.TaggedError("UNSAFE_PATH_SEGMENT")<{
  readonly field: "ticket" | "runId"
  readonly value: string
}> {}

/** `git rev-parse --show-toplevel` had no answer — without a repo root there is nowhere to run. */
export class RepoRootUnavailable extends Data.TaggedError("REPO_ROOT_UNAVAILABLE")<{
  readonly detail: string
}> {}

/**
 * The one resolution of a repo root: `runScopedLayers` reads it to key the run's paths, and the
 * `resume-run` node reads it standalone from the CLI, before any run exists.
 */
export const resolveRepoRoot = gitRead(
  ["git", "rev-parse", "--show-toplevel"],
  undefined,
  (fields) => new RepoRootUnavailable({ detail: fields.stderr })
)

/**
 * `git rev-parse --git-common-dir` had no answer at one of the two roots, so the run cannot tell
 * whether its target is this pipeline's own repository. That answer places the run's records
 * (`recordsRootFor`, below), so a run that cannot get it fails here rather than picking a root by
 * guess.
 */
export class RepositoryIdentityUnavailable extends Data.TaggedError("REPOSITORY_IDENTITY_UNAVAILABLE")<{
  readonly detail: string
}> {}

/**
 * `fs.makeTempDirectoryScoped` failed while minting a foreign run's records root under the default
 * `records: "run-root"` policy — `stage-shipped-graph/stage.ts`'s `StageFailed` precedent for
 * naming a platform error rather than leaving it raw. As unlikely in practice as any other OS temp
 * directory allocation, and named for the same reason those are: a closed error union stays closed.
 */
export class RecordsTempDirFailed extends Data.TaggedError("RECORDS_TEMP_DIR_FAILED")<{
  readonly detail: string
}> {}

export interface RunScope {
  readonly ticket: string
  readonly graph: string
  /**
   * The run's execution shape, required — no absent key, no default. Every graph declares its
   * own (`develop-graph` and `conflict-graph` isolate by default; the rest run in the primary
   * checkout). Making this required is the point: a future graph
   * cannot compile without answering the question, which is what "the flag is gone, not defaulted"
   * asks for one layer up from the CLI.
   */
  readonly worktree: boolean
  /**
   * Whether this run continues a prior one. Optional, absent means `false` — the cold run every
   * graph wants, so no graph states it explicitly. `true`
   * sends `runScopedLayers` down the resume branch: a predecessor is selected (`resume.ts`), its
   * work root adopted, and a `resume-run` record opens this run's journal.
   */
  readonly resume?: boolean
  /**
   * Where this run's records go (`RunInfoService.records`'s own doc). Optional, absent means
   * `"run-root"`, the default every graph that says nothing gets. A graph that wants the repo copy
   * committed states `"committed"` here, threaded through from its own input (`develop-graph`'s
   * `records` field).
   */
  readonly records?: "run-root" | "committed"
}

/** The process-environment slice the path composers read. */
export interface RootEnv {
  readonly env: Env
  readonly home: string
}

/**
 * A `Context.Reference`, like every custom service here: the default reads the real process
 * environment, and a test provides a fixture value instead of mutating globals — which also lets a
 * test redirect a whole graph's artifact root from outside its `run`.
 */
export const RunRootEnv = Context.Reference<RootEnv>("mag/runtime/RunRootEnv", {
  defaultValue: (): RootEnv => ({ env: process.env, home: homedir() })
})

/**
 * The explicit "does this run already have a scope" signal. Default `false`, matching every
 * other custom service here — a composed subgraph reads `true` (set by the host's own
 * `runScopedLayers` call) and mints no second scope of its own, rather than that fact being
 * re-inferred from `RunInfo.graph === ""` or some other incidental shape.
 */
export const RunScoped = Context.Reference<boolean>("mag/runtime/RunScoped", {
  defaultValue: (): boolean => false
})

/**
 * Builds the layers one run provides to its pipeline: the journal (writing to
 * `<config>/graph/<project>/<ticket>/<runId>/journal.jsonl`, `run-root.ts`) and the run info every
 * journal row is stamped with. Both segments taken from outside are gated first, so a hostile
 * ticket id dies here, before `journalLayer` creates a directory.
 *
 * `scope.resume` decides the predecessor. `false` passes `Option.none()` — a first run replays
 * nothing. `true` selects one (`resume.ts`'s `selectPredecessor`, the newest-sibling selection
 * deferred until resume work actually exercises it), adopts its work root, and opens this run's own
 * journal with a `resume-run` record before any node runs — so the choice is visible in the run it
 * produced, not just in the log line that made it.
 *
 * Idempotent under nesting. A host graph's own call is the run's root and sets `RunScoped`;
 * a subgraph composed beneath it calls this again with its own `scope`, sees `RunScoped` already
 * set, and returns `Layer.empty` before the ticket-safety checks or the shell — the subgraph then
 * runs under the host's journal, run info and `workRoot` rather than minting its own.
 */
export const runScopedLayers = Effect.fn("runScopedLayers")(function* (scope: RunScope) {
  if (yield* RunScoped) return Layer.empty

  const root = yield* RunRootEnv
  const runId = yield* RunId
  if (!isSafeSegment(scope.ticket)) {
    return yield* Effect.fail(new UnsafePathSegment({ field: "ticket", value: scope.ticket }))
  }
  if (!isSafeSegment(runId)) {
    return yield* Effect.fail(new UnsafePathSegment({ field: "runId", value: runId }))
  }

  const repoRoot = yield* resolveRepoRoot

  // One set of parts names the run directory — the journal writes into it, and RunInfo
  // carries the same value so a node (e.g. `design`) can place an artifact there.
  const parts = { ...root, repoPath: repoRoot, ticket: scope.ticket, runId }
  const runRoot = runDirFor(parts)
  const path = journalPathFor(parts)

  // The one line that decides where the run executes. Composed here, before any
  // node runs — run-scoped constants stay constant — but not yet materialized:
  // `worktree-add` creates the directory at this path later in the pipeline. `repoRoot` keeps
  // keying `runRoot` and the journal's own `repoRoot` stamp either way. A cold run
  // keys it to its own run id; a resumed run keys it to the predecessor's, below.
  const workRootFor = (runId: string) =>
    scope.worktree ? worktreeDirFor({ repoPath: repoRoot, ticket: scope.ticket, runId }) : repoRoot

  // The second identity question, resolved once, here, beside `repoRoot`, and resolved
  // unconditionally, ahead of the cold/resume branch below: `recordsRoot` is minted for every run of
  // every graph, never only for a resumed one.
  const shell = yield* Shell

  // "is the target this repository" — the one git question a worktree cannot fool
  // (`--show-toplevel` differs across worktrees of the same repository; `--git-common-dir` does
  // not). A failed read on either side fails the run: the placement below is a function of this
  // answer, and no root is worth guessing in its place.
  const repoCommon = yield* shell.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot })
  const homeCommon = yield* shell.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: PIPELINE_ROOT })
  if (repoCommon.exitCode !== 0 || homeCommon.exitCode !== 0) {
    return yield* Effect.fail(
      new RepositoryIdentityUnavailable({ detail: (repoCommon.exitCode !== 0 ? repoCommon : homeCommon).stderr.trim() })
    )
  }
  const sameRepository = repoCommon.stdout.trim() === homeCommon.stdout.trim()

  // The records policy this run was launched with (`RunScope.records`'s own doc) — this
  // repository's default, or whatever a foreign target declares — resolved once, here,
  // rather than at each of the two call sites below — `recordsRootFor` and `runInfoFor` must agree
  // on the exact same value.
  const recordsPolicy = scope.records ?? "run-root"

  // The placement decision's one authoritative home. `recordsRoot` is `workRoot` — every composed
  // path the same string it is today — whenever the two trees can be one and the same: every run
  // against this repository, whichever policy is declared, and a foreign run under `records:
  // "committed"` too, since a foreign run's committed record commits on the target's own current
  // branch (`commitPath`'s ordinary pathspec-scoped add/commit, `records.ts`'s `record`), the CLAUDE.md
  // doc line "committed to the branch". Only a foreign run under the default `run-root` policy splits
  // the two: nothing ever commits into that root, so it mints a disposable OS temp directory instead —
  // `stage-shipped-graph/stage.ts`'s own `fs.makeTempDirectory` idiom, outside `~/.claude/**` where
  // the agent's own Write tool is refused. Not `runRoot` either way: the sensitive-file guard refuses
  // an agent write under `~/.claude/**`, proven repeatedly, so an agent-written record has nowhere to
  // go there. A function of THIS run's own id, never the predecessor's — a resumed run resolves its
  // own records root below even though it adopts the predecessor's `workRoot`: the two roots answer
  // different questions and stay independent, except where `recordsRoot` is defined to equal
  // `workRoot` and so is adopted along with it by construction.
  //
  // Materialized here, where the decision is, not by a graph step. `recordsRoot` is minted
  // for every run of every graph, and every entry point that writes a record (`discover`,
  // `brainstorm`, `design`, `envision-notation`, `design-graph`, `develop-graph`) builds these layers,
  // so the root exists for all of them rather than only for the one host that remembered a step.
  // A home run makes no temp-directory call here at all.
  const recordsRootFor = (workRoot: string) =>
    Effect.gen(function* () {
      if (sameRepository || recordsPolicy === "committed") return workRoot
      const fs = yield* FileSystem.FileSystem
      // Scoped, not `makeTempDirectory`: this directory must not outlive the run that minted
      // it — `fs.makeTempDirectoryScoped`'s own finalizer removes it when the caller's scope
      // closes, which `graph()` and `graphs/envision/graph.ts` open around this whole call plus the pipeline
      // it hands the layers to, success or failure alike.
      return yield* fs.makeTempDirectoryScoped({ prefix: "records-" }).pipe(
        Effect.catch((error) => Effect.fail(new RecordsTempDirFailed({ detail: String(error) })))
      )
    })

  const runInfoFor = (workRoot: string, recordsRoot: string): Effect.Effect<RunInfoService> =>
    Effect.map(runInfoValues(repoRoot), (values) => ({
      ticket: scope.ticket,
      graph: scope.graph,
      repoRoot,
      runRoot,
      workRoot,
      recordsRoot,
      records: recordsPolicy,
      ...values
    }))

  if (scope.resume !== true) {
    const workRoot = workRootFor(runId)
    const recordsRoot = yield* recordsRootFor(workRoot)
    return Layer.mergeAll(
      journalLayer({ path, graph: scope.graph, predecessor: Option.none() }).pipe(Layer.provide(platform)),
      Layer.succeed(RunInfo, yield* runInfoFor(workRoot, recordsRoot)),
      Layer.succeed(RunScoped, true)
    )
  }

  // The predecessor is chosen before anything else — nothing has been written
  // yet (the run directory is created by `makeJournal`, below, never before this point), so a
  // refused resume (`ResumeWithoutPredecessor`) leaves no trace on disk.
  const selection = yield* selectPredecessor({ ticketDir: ticketDirFor(parts), graph: scope.graph })

  // A resumed run works where its predecessor worked, so the replayed prefix and the live tail
  // agree on one tree. Adopted from the predecessor's own record when it recorded one (it was itself
  // a resume); otherwise composed from the PREDECESSOR's run id — keying it to this run's own would
  // point a resumed run at a worktree directory nothing ever created.
  const workRoot = Option.getOrElse(selection.workRoot, () => workRootFor(selection.predecessorRunId))
  const recordsRoot = yield* recordsRootFor(workRoot)
  const runInfo = yield* runInfoFor(workRoot, recordsRoot)

  // The resume record: this run's own `resume-run` start/end pair, stamped like any other row and
  // written before the pipeline's layers are returned, so it is the journal's first two lines
  // (visible in the resumed run's own record). Built from the SAME journal instance the
  // pipeline goes on to use (`makeJournal`, not `journalLayer` a second time): one read of the
  // predecessor's rows, not two. The record states the tree this run adopted, so the adopted value
  // replaces `selection`'s own `Option` of the predecessor's.
  const record = { ...selection, workRoot }
  const journal = yield* makeJournal({ path, graph: scope.graph, predecessor: Option.some(selection.journalPath) }).pipe(
    Effect.provide(platform),
    // A run whose own record failed to write has lost the one thing it was keeping (`journaled.ts`'s
    // own rule for the same failure mode) — this dies as a defect, never as a member of
    // `runScopedLayers`' own (closed) error union.
    Effect.orDie
  )
  yield* Effect.gen(function* () {
    const stamp = { run: runInfo, node: RESUME_NODE, attempt: yield* journal.attempt(RESUME_NODE), input: Option.none() }
    yield* journal.append(startRow({ ...stamp, timestamp: yield* nowIso }))
    yield* journal.append(
      ranEndRow({ ...stamp, timestamp: yield* nowIso, exit: Exit.succeed(record), success: Option.some(record) })
    )
  }).pipe(Effect.orDie)

  return Layer.mergeAll(
    Layer.succeed(Journal, journal),
    Layer.succeed(RunInfo, runInfo),
    Layer.succeed(RunScoped, true)
  )
// `platform` provided here, not by each caller: `recordsRootFor`'s temp-directory branch is the
// only user of `FileSystem` in this whole function, and providing it locally keeps every other
// reference this function reads at `never` (`Shell`, `RunRootEnv`, `RunId`, `RunScoped` are all
// `Context.Reference`s, R = never by construction). `Scope` is the one deliberate exception:
// `fs.makeTempDirectoryScoped` puts it in this function's own R, left unprovided on purpose, so
// the caller's own `Effect.scoped` (`graph()`, `graphs/envision/graph.ts`) decides when the temp directory this
// mints is actually removed — the run's own lifetime, not this function's.
}, Effect.provide(platform))
