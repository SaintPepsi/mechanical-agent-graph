import { Array as Arr, Effect, FileSystem, Option, Path } from "effect"
import { directoriesAmong } from "mag/graph-nodes/conformance/discovery"
import type { IoFailure } from "mag/graph-nodes/conformance/errors"
import { classifyExtras } from "mag/graph-nodes/conformance/ownership"
import { LOADED_FILES, REQUIRED_FILES } from "mag/runtime/graph-node.shape"

/** The I/O snapshot for one node directory — every rule reads this, never the filesystem. */
export interface NodeUnderCheck {
  readonly name: string
  readonly dir: string
  readonly extraSources: readonly string[]
  readonly extraJunk: readonly string[]
  readonly sources: ReadonlyMap<string, string>
  readonly modules: ReadonlyMap<string, Option.Option<Record<string, unknown>>>
  /** Every I/O failure caught while gathering this node — listing, stat, or read. */
  readonly failures: readonly IoFailure[]
}

/**
 * One I/O pass per node. A missing `REQUIRED_FILES` entry is absent from `sources`, never a failed
 * `Effect`. `modules` covers only `LOADED_FILES`: importing `graph-node.test.ts` would run its
 * top-level body and then throw. `Effect.option` over the one `Promise` boundary in this file keeps a
 * throwing or type-broken module an `Option.none()` rather than a crash.
 *
 * Extras aren't knowable until the directory is listed, so `readSources` sequences after `discover`
 * (`classifyExtras` decides which extra entries are source files) and reads
 * `[...REQUIRED_FILES, ...extraSources]` in that exact order — required-first insertion order is
 * load-bearing for existing `toEqual` assertions elsewhere in the suite. `readModules` stays
 * concurrent with the discover-then-readSources chain via `Effect.all`, untouched: that is the line
 * that keeps ownership type-agnostic and text-only, reading source strings rather than imported types.
 *
 * Infallible. `readSources` widens its catch so any `readFileString` failure other than `NotFound`
 * becomes an `IoFailure` instead of failing the Effect; `directoriesAmong` already never fails; and
 * `discoverThenReadSources` carries one final catch for the one failure mode left once those two
 * catch their own — `fs.readDirectory` on the node directory itself — which degrades to an empty
 * snapshot plus a single `IoFailure { entry: "" }` rather than attempting a pointless read pass.
 */
export const gather = Effect.fn("gather")(function* (root: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(root, name)

  type ReadResult =
    | { readonly kind: "ok"; readonly file: string; readonly text: string }
    | { readonly kind: "missing"; readonly file: string }
    | { readonly kind: "failed"; readonly file: string; readonly detail: string }

  const readSources = (files: readonly string[]) =>
    Effect.forEach(
      files,
      (file) =>
        fs.readFileString(path.join(dir, file)).pipe(
          Effect.map((text): ReadResult => ({ kind: "ok", file, text })),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed<ReadResult>({ kind: "missing", file })
          ),
          Effect.catch((error) => Effect.succeed<ReadResult>({ kind: "failed", file, detail: String(error) }))
        ),
      { concurrency: "unbounded" }
    ).pipe(
      Effect.map((results) => {
        const sources = new Map<string, string>()
        const failures: IoFailure[] = []
        for (const result of results) {
          if (result.kind === "ok") sources.set(result.file, result.text)
          else if (result.kind === "failed") failures.push({ entry: result.file, detail: result.detail })
        }
        return { sources, failures }
      })
    )

  const discoverThenReadSources = fs.readDirectory(dir).pipe(
    Effect.map((raw) => raw.slice().sort()),
    Effect.flatMap((entries) =>
      directoriesAmong(dir, entries).pipe(
        Effect.flatMap(({ directories, failures: statFailures }) => {
          const { extraSources, extraJunk } = classifyExtras(entries, directories)
          return readSources([...REQUIRED_FILES, ...extraSources]).pipe(
            Effect.map(({ sources, failures: readFailures }) => ({
              extraSources,
              extraJunk,
              sources,
              failures: [...statFailures, ...readFailures]
            }))
          )
        })
      )
    ),
    Effect.catch((error) =>
      Effect.succeed({
        extraSources: [] as readonly string[],
        extraJunk: [] as readonly string[],
        sources: new Map<string, string>(),
        failures: [{ entry: "", detail: String(error) }] as readonly IoFailure[]
      })
    )
  )

  const readModules = Effect.forEach(
    LOADED_FILES,
    (file) =>
      Effect.tryPromise(() => import(path.join(dir, file)) as Promise<Record<string, unknown>>).pipe(
        Effect.option,
        Effect.map((loadedModule) => [file, loadedModule] as const)
      ),
    { concurrency: "unbounded" }
  ).pipe(Effect.map((moduleEntries) => new Map<string, Option.Option<Record<string, unknown>>>(moduleEntries)))

  const [{ extraSources, extraJunk, sources, failures }, modules] = yield* Effect.all(
    [discoverThenReadSources, readModules],
    { concurrency: "unbounded" }
  )

  return { name, dir, extraSources, extraJunk, sources, modules, failures } satisfies NodeUnderCheck
})
