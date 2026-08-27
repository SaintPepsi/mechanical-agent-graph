import { Effect, FileSystem, Option, Path } from "effect"
import type { IoFailure } from "mag/graph-nodes/conformance/errors"
import { RootUnreadable, UnknownNode } from "mag/graph-nodes/conformance/errors"

/** Node names under root, plus every root entry whose `fs.stat` failed. */
export interface Discovered {
  readonly names: readonly string[]
  readonly failures: readonly IoFailure[]
}

type StatResult =
  | { readonly kind: "ok"; readonly entry: string; readonly isDirectory: boolean }
  | { readonly kind: "failed"; readonly entry: string; readonly detail: string }

/**
 * Which of a directory's `entries` are themselves directories — one `fs.stat` per entry, run
 * concurrently. Never fails as a whole: an entry whose `fs.stat` fails is caught individually into
 * `failures` rather than aborting the classification of the rest, and is neither a directory nor
 * silently dropped.
 */
export const directoriesAmong = Effect.fn("directoriesAmong")(function* (dir: string, entries: readonly string[]) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const classified: readonly StatResult[] = yield* Effect.forEach(
    entries,
    (entry) =>
      fs.stat(path.join(dir, entry)).pipe(
        Effect.map((info): StatResult => ({ kind: "ok", entry, isDirectory: info.type === "Directory" })),
        Effect.catch((error) => Effect.succeed<StatResult>({ kind: "failed", entry, detail: String(error) }))
      ),
    { concurrency: "unbounded" }
  )

  const directories: string[] = []
  const failures: IoFailure[] = []
  for (const result of classified) {
    if (result.kind === "failed") failures.push({ entry: result.entry, detail: result.detail })
    else if (result.isDirectory) directories.push(result.entry)
  }

  return { directories, failures: failures.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0)) }
})

/**
 * Node names one level directly under `root` — directories only, sorted, non-recursive. An
 * unreadable root is CONFORMANCE_ROOT_UNREADABLE. Entries `fs.stat` couldn't classify ride along
 * as `failures` rather than aborting discovery.
 */
const discoverNodes = Effect.fn("discoverNodes")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem

  const entries = yield* fs.readDirectory(root).pipe(
    Effect.catch((error) => new RootUnreadable({ root, detail: String(error) }))
  )

  const { directories, failures } = yield* directoriesAmong(root, entries)
  return { names: directories.sort(), failures } satisfies Discovered
})

/**
 * Every discovered name when `name` is absent; the one matching name, or CONFORMANCE_UNKNOWN_NODE.
 * `--name` also matches a failed entry, reporting its failure rather than claiming no such node
 * exists, and scopes `failures` to the selection so an unrelated entry's failure never leaks into
 * a `--name` run.
 */
export const selectNodes = Effect.fn("selectNodes")(function* (root: string, name: Option.Option<string>) {
  const discovered = yield* discoverNodes(root)

  return yield* Option.match(name, {
    onNone: () => Effect.succeed(discovered),
    onSome: (selected): Effect.Effect<Discovered, UnknownNode> => {
      if (discovered.names.includes(selected)) return Effect.succeed({ names: [selected], failures: [] })
      const failed = discovered.failures.find((failure) => failure.entry === selected)
      if (failed !== undefined) return Effect.succeed({ names: [], failures: [failed] })
      return new UnknownNode({ name: selected, root })
    }
  })
})
