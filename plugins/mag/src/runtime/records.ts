import { posix } from "node:path"
import { Effect, FileSystem } from "effect"
import { commitPath, type CommitFailureFields, type GitFailureFields } from "mag/runtime/git"
import { recordsDir, RunInfo } from "mag/runtime/run-info"

/** Fields a missing, blank, or unchanged-from-snapshot record's `E` constructor receives — every
 *  writer node's own `*Missing`/`*NoteMissing` tag already carries exactly this shape. */
export interface RecordMissingFields {
  readonly path: string
  readonly sessions: readonly string[]
}

/** Fields a failed run-root copy's `E` constructor receives — `design/errors.ts`'s `DesignCopyFailed`
 *  shape, generalised the same way `git.ts`'s `GitFailureFields`/`CommitFailureFields` are. */
export interface RecordCopyFailedFields {
  readonly path: string
  readonly detail: string
  readonly sessions: readonly string[]
}

/**
 * The one seam every record-writing node's dispatch spine ends at — `discover`,
 * `brainstorm` and `design` all share this check-copy-commit shape rather than each carrying a copy
 * of it. The check and the copy are mechanical and run unconditionally; only the commit is gated on
 * the records policy the run was launched with (`RunInfoService.records`), which is the target
 * repository's own declaration: the node checks and copies, it commits only when that policy says to.
 *
 * `path` is the caller's own computed destination (`recordPath`), never the model's echo of it —
 * every writer already reads the file back at this same path rather than trusting a verdict. `before`
 * is the pre-dispatch snapshot the caller took: a written file identical to it, or blank, both read
 * as "the session declared success but produced nothing new," `envision-mermaid`'s own idiom.
 *
 * The four tagged errors are supplied by the caller, never minted here — a closed error union stays
 * closed (repo `CLAUDE.md`), so `discover`'s `DiscoverNoteMissing` and `design`'s `DesignCopyFailed`
 * keep meaning exactly what they always have.
 */
export const record = <EMissing, ECopy, EGit, ECommit>(
  path: string,
  options: {
    readonly before: string
    readonly message: string
    readonly sessions: readonly string[]
    readonly onMissing: (fields: RecordMissingFields) => EMissing
    readonly onCopyFailed: (fields: RecordCopyFailedFields) => ECopy
    readonly onGitFailure: (fields: GitFailureFields) => EGit
    readonly onCommitFailure: (fields: CommitFailureFields) => ECommit
  }
) =>
  Effect.gen(function* () {
    const runInfo = yield* RunInfo
    const fs = yield* FileSystem.FileSystem
    const { before, message, sessions } = options

    const written = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed("")))
    if (written.trim() === "" || written === before) {
      return yield* Effect.fail(options.onMissing({ path, sessions }))
    }

    // The run root gets a copy whichever policy the run declares — written by this
    // process, which the sensitive-file guard doesn't bind (`design/graph-node.ts`'s own reasoning,
    // generalised to every writer). Named by basename alone, not `artifact.ts`'s numbered
    // `<prefix>-<pass>` scheme: a second pass of the same node overwrites this copy in place, so it
    // is always the latest version of the record, never an append-only history of every pass.
    if (runInfo.runRoot === "") {
      return yield* Effect.fail(options.onCopyFailed({ path, detail: "run root missing", sessions }))
    }
    const copyPath = `${runInfo.runRoot}/${posix.basename(path)}`
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(runInfo.runRoot, { recursive: true })
      yield* fs.writeFileString(copyPath, written)
    }).pipe(
      Effect.catch((error) => Effect.fail(options.onCopyFailed({ path: copyPath, detail: String(error), sessions })))
    )

    // The commit half, gated on that same policy. `run-root` (the default) stops above; `committed`
    // also stages and commits the repo copy, `commitPath`'s own pathspec-scoped add-diff-commit
    // spine (`git.ts`), so a foreign policy never sweeps in anything but this file.
    if (runInfo.records === "committed") {
      yield* commitPath(recordsDir(runInfo), path, message, sessions, options.onGitFailure, options.onCommitFailure)
    }

    return { written, copyPath }
  })

/**
 * The `runRoot === ""` wiring-bug check `design/graph-node.ts` runs before dispatch
 * (`DesignRunRootMissing`), shared so `discover`, `brainstorm`, `recycle-scan`,
 * `envision-mermaid` and `envision-rail-sketch` gate on the same fact before dispatching instead of
 * paying for a session first. `discover`, `brainstorm` and `recycle-scan` map it onto their own
 * `*CopyFailed`/`*WriteFailed` tag with detail `"run root missing"`, the same detail `record` uses when it catches
 * the same fact later, inside `onCopyFailed`; `design`, `envision-shell`, `envision-mermaid` and `envision-rail-sketch`
 * each keep a dedicated `*RunRootMissing` tag instead, `design`'s own `DesignRunRootMissing`
 * precedent. `onMissing` is the caller's own tagged error, the closed-error-union rule every export
 * here already follows.
 */
export const requireRunRoot = <E>(onMissing: () => E): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const runInfo = yield* RunInfo
    if (runInfo.runRoot === "") return yield* Effect.fail(onMissing())
  })
