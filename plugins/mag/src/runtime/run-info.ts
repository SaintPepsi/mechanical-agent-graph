import { Context } from "effect"

/**
 * The run-scoped constants every journal row is stamped with. They describe the run, not
 * the node, so a node never carries them as input and never returns them — they reach `journaled`
 * through the `R` channel (`rebuild-sketch.md`, "Addendum: what a GraphNode is given").
 *
 * A `Context.Reference`, matching `trace/sink.ts`'s `TraceSinks` and `shell.ts`'s `Shell`: a read
 * with nothing provided resolves rather than failing, which is what keeps `CommandNode`'s pinned
 * `R = never` (`runtime/types.ts`'s `CommandNode`) reachable from the CLI.
 *
 * This file imports `effect` and nothing else, and `run-info-layer.ts` holds the wiring that
 * resolves these values. The split is what keeps a node's compile surface small: `journaled` is
 * applied at every node's definition, so anything this module reaches, every node reaches — and
 * the layer reaches `Shell` (Bun) and `trace/layer.ts` (process globals), which no node needs to
 * see to be typechecked.
 */
export interface RunInfoService {
  readonly runId: string
  readonly ticket: string
  readonly graph: string
  readonly repoRoot: string
  /** The commit the run started from. `""` when git had no answer — never a valid sha, so the two cases stay distinguishable. */
  readonly sha: string
  /** The executing plugin checkout's own commit, `""` on the same terms as `sha`. Distinct from `sha`: this names the pipeline that ran the node, not the repo the node ran against. */
  readonly pipelineSha: string
  /** The run directory (`run-root.ts`'s `runDirFor`), the same one the journal writes `journal.jsonl` into. */
  readonly runRoot: string
  /**
   * Where this run's nodes work — the worktree `worktree-add` materializes, in worktree
   * mode, otherwise `repoRoot`. Distinct from `repoRoot` on purpose: `repoRoot` keys `projectKey`,
   * `runRoot` and the journal's `repoRoot` stamp,
   * and none of those may re-point at a worktree a green run then deletes. Every `workdir()` reader
   * runs after `worktree-add`; that ordering is carried by this comment and by
   * `graphs/develop-graph/graph.test.ts`, not by the type system.
   */
  readonly workRoot: string
  /**
   * Where this run's records are written, and (under `records: "committed"`) committed. `workRoot`
   * whenever the two trees can be one and the same: every run against this repository, whichever
   * policy is declared, and a foreign run under `records: "committed"` too — that record commits on
   * the target's own current branch (held by construction: this is the only root a record's path
   * ever hangs from). Only a foreign run under the default `"run-root"` policy splits the two: a
   * disposable OS temp directory, since nothing ever commits into it.
   */
  readonly recordsRoot: string
  /**
   * Where a run's records go: the target repository's declared policy, threaded in at launch
   * (`RunScope.records`, `run-layers.ts`). `"run-root"` (the default): every record-writing node
   * checks the file and copies it into the run root, never touching git. `"committed"`: the same
   * check and copy, plus a `git add`/`git commit` of the repo copy under `recordsRoot`
   * (`records.ts`'s `record`).
   */
  readonly records: "run-root" | "committed"
}

/**
 * The default is a fallback only: a run that provides a live `Journal` provides `runInfoValues` (`run-info-layer.ts`)
 * alongside it, and the no-op `Journal` default discards every row anyway, so these values reach a
 * file in no configuration. `runId` mirrors `RunId`'s own default (`trace/layer.ts:12-14`).
 */
export const RunInfo: Context.Reference<RunInfoService> = Context.Reference<RunInfoService>(
  "mag/runtime/RunInfo",
  {
    defaultValue: () => ({
      runId: crypto.randomUUID(),
      ticket: "",
      graph: "",
      repoRoot: "",
      sha: "",
      pipelineSha: "",
      runRoot: "",
      workRoot: "",
      recordsRoot: "",
      records: "run-root"
    })
  }
)

/** `""` means "inherit the process's cwd", not a path — every node reads a run-scoped root through this. */
const nonEmpty = (value: string): string | undefined => (value === "" ? undefined : value)

/**
 * The cwd every in-tree node uses — `branch`, `design`, `build`, `verification`,
 * `review-diff` and `push-branch`. One home, rather than each of those nodes carrying its own copy
 * of the same `repoRoot === "" ? undefined : repoRoot` one-liner.
 */
export const workdir = (run: RunInfoService): string | undefined => nonEmpty(run.workRoot)

/**
 * The cwd for work that must happen in the primary checkout — `resolve-base` (refs are
 * shared across every worktree of a repository, and this runs before the worktree exists anyway),
 * plus the two worktree nodes themselves, which by construction never run inside the tree they are
 * creating or removing.
 */
export const primaryDir = (run: RunInfoService): string | undefined => nonEmpty(run.repoRoot)

/** The cwd a record's commit runs in — `recordPath`'s own root, read back the `""`-means-inherit way. */
export const recordsDir = (run: RunInfoService): string | undefined => nonEmpty(run.recordsRoot)

/**
 * The one composer every record writer and reader calls — `discover`, `envision-shell`,
 * `brainstorm` and registry-only `design` each drop their own private `workRoot === "" ? relative :
 * ...` ternary onto this. String concatenation, not `Path.join`, `run-root.ts`'s own reason: these
 * values feed shell globs and git pathspecs downstream, where a backslash silently matches nothing.
 */
export const recordPath = (run: RunInfoService, relative: string): string =>
  run.recordsRoot === "" ? relative : `${run.recordsRoot}/${relative}`
