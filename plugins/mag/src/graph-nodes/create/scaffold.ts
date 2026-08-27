import { Effect, Exit, FileSystem, Path } from "effect"
import { NodeAlreadyExists, ScaffoldFailed } from "mag/graph-nodes/create/errors"
import { emittedFiles } from "mag/graph-nodes/create/template"
import { cleanDescription, validName } from "mag/graph-nodes/create/validation"

/**
 * The one syscall that is both the collision check and the proof of ownership.
 * A non-recursive `makeDirectory` either creates the directory (this invocation now owns it,
 * which is exactly what scopes `withCleanup`) or fails `AlreadyExists` (the collision itself —
 * nothing was touched, because the call that would have touched it is the call that failed).
 * Any other failure reason is not a collision and maps to `ScaffoldFailed`. Deliberately no
 * `fs.exists` pre-check: that would reopen the check-then-create race this single call closes
 * (probed live: a non-recursive `makeDirectory` against an existing path fails with
 * `error.reason._tag === "AlreadyExists"`, mirroring `gather.ts`'s read of `"NotFound"`).
 */
const makeDirectoryExclusive = (root: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = path.join(root, name)

    yield* fs.makeDirectory(directory, { recursive: false }).pipe(
      Effect.catch(
        (error): Effect.Effect<never, NodeAlreadyExists | ScaffoldFailed> =>
          error.reason._tag === "AlreadyExists"
            ? Effect.fail(new NodeAlreadyExists({ name, directory }))
            : Effect.fail(new ScaffoldFailed({ directory, detail: String(error) }))
      )
    )

    return directory
  })

/**
 * Removes `directory` on any non-success exit of `effect` — failure, defect, or
 * interrupt alike, which is why `Effect.onExit` is the right combinator here (its finalizer runs
 * on all three, unlike a plain `catch`). The removal effect's own failure is ignored: a cleanup
 * that fails must never replace the real error with an inaccurate one.
 */
export const withCleanup = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            yield* fs.remove(directory, { recursive: true }).pipe(Effect.ignore)
          })
    )
  )

/** Writes every entry of `files` into `directory`. The write phase only — the phase `withCleanup` wraps. */
const writeAll = (directory: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    yield* Effect.forEach(
      Object.entries(files),
      ([file, contents]) => fs.writeFileString(path.join(directory, file), contents),
      { concurrency: "unbounded" }
    )
  }).pipe(Effect.catch((error) => Effect.fail(new ScaffoldFailed({ directory, detail: String(error) }))))

/**
 * The only I/O in `create`. Validate name and description, build every emitted
 * file's source in memory (pure, cannot fail), then touch disk — everything that can fail
 * without writing anything fails first, so an invalid name or description leaves nothing written,
 * by construction, not by cleanup. Directory creation itself sits outside `withCleanup`: a failed or
 * colliding `makeDirectoryExclusive` never created anything, so there is nothing to clean up.
 */
export const scaffold = (root: string, input: { readonly name: string; readonly description: string }) =>
  Effect.gen(function* () {
    const name = yield* Effect.fromResult(validName(input.name))
    const description = yield* Effect.fromResult(cleanDescription(input.description))
    const files = emittedFiles(name, description)

    const directory = yield* makeDirectoryExclusive(root, name)
    yield* withCleanup(directory, writeAll(directory, files))

    return { directory }
  })
