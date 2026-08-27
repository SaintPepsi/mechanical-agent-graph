import { Effect, FileSystem, Path } from "effect"
import { GraphFolderCreateFailed, UnsafeGraphName } from "mag/graph-nodes/create-graph-folder/errors"
import { isSafeSegment } from "mag/runtime/run-root"

/**
 * Resolves `name` to `<root>/<name>` and creates it when absent. `root` travels as a
 * parameter (`create/scaffold.ts`'s own precedent) so this stays testable against a disposable
 * fixture root; `graph-node.ts` is the only caller that hardwires the live `DEFAULT_GRAPHS_ROOT`.
 *
 * Idempotent by construction, not by an exclusivity check: a re-run should succeed with
 * `created: false`, the opposite of `create`'s own `makeDirectoryExclusive`, whose whole point is to
 * refuse a second run. A recursive `makeDirectory` over a path that already exists simply succeeds,
 * so the existence check that decides `created` runs first, read-only, before anything is touched.
 */
export const createFolder = (root: string, name: string) =>
  Effect.gen(function* () {
    if (!isSafeSegment(name)) {
      return yield* Effect.fail(new UnsafeGraphName({ name }))
    }

    const path = yield* Path.Path
    const folder = path.join(root, name)

    const fs = yield* FileSystem.FileSystem
    // `topology.ts`'s own `existsOrFalse` idiom: a read whose only question is yes/no.
    const existed = yield* fs.exists(folder).pipe(Effect.catch(() => Effect.succeed(false)))
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(
      Effect.catch((error) => Effect.fail(new GraphFolderCreateFailed({ folder, detail: String(error) })))
    )

    return { folder, created: !existed }
  })
