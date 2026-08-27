import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { GraphFolderCreateFailed, UnsafeGraphName } from "mag/graph-nodes/create-graph-folder/errors"
import { createFolder } from "mag/graph-nodes/create-graph-folder/folder"
import { createGraphFolder } from "mag/graph-nodes/create-graph-folder/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/create-graph-folder/examples"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"

/**
 * `createGraphFolder.run` itself is never called here — it hardwires the live `DEFAULT_GRAPHS_ROOT`
 * (`create/graph-node.test.ts`'s own precedent for `create.run`, which hardwires
 * `DEFAULT_GRAPH_NODES_ROOT` the same way). `createFolder`, the parametrized helper the node wraps,
 * is what stays testable against a disposable fixture root.
 */
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provide(platform))))

/** Deletes a fixture directory, and only a fixture directory: anything outside tmpdir is refused (`design/graph-node.test.ts`'s own idiom). */
const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

describe("createGraphFolder", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(createGraphFolder.input)) throw new Error("createGraphFolder.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(createGraphFolder.input)(example)
    if (!isSchemaHandle(createGraphFolder.success)) throw new Error("createGraphFolder.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(createGraphFolder.success)(example)
  })
})

describe("createFolder", () => {
  const withRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), "create-graph-folder-"))
    try {
      await fn(root)
    } finally {
      await removeDir(root)
    }
  }

  test("creates the folder under root, reporting created: true", () =>
    withRoot(async (root) => {
      const result = await run(createFolder(root, "envision"))
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ folder: join(root, "envision"), created: true })
      expect(existsSync(join(root, "envision"))).toBe(true)
    }))

  test("a second run over an existing folder succeeds with created: false, no second directory", () =>
    withRoot(async (root) => {
      await run(createFolder(root, "envision"))
      writeFileSync(join(root, "envision", "vision.md"), "kept")

      const result = await run(createFolder(root, "envision"))
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ folder: join(root, "envision"), created: false })
      // Idempotent, not destructive: the re-run never touched what was already inside.
      expect(readdirSync(join(root, "envision"))).toStrictEqual(["vision.md"])
    }))

  const unsafe = ["", ".", "..", "a/b", "a\\b", "a\0b"]

  test.each(unsafe)("an unsafe name shape %j fails UnsafeGraphName with nothing on disk", async (name) => {
    await withRoot(async (root) => {
      const result = await run(createFolder(root, name))
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(UnsafeGraphName)
      expect(readdirSync(root)).toStrictEqual([])
    })
  })

  test("a folder that cannot be created fails GraphFolderCreateFailed, carrying the path and a detail", async () => {
    // A real file sitting where the folder needs to be a directory: `makeDirectory` fails ENOTDIR —
    // `design/graph-node.test.ts`'s own blocker idiom, reproducing the failure without mocking `FileSystem`.
    await withRoot(async (root) => {
      const blocker = join(root, "blocker")
      writeFileSync(blocker, "not a directory")

      const result = await run(createFolder(blocker, "envision"))
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(GraphFolderCreateFailed)
      const failure = result.failure as GraphFolderCreateFailed
      expect(failure.folder).toBe(join(blocker, "envision"))
      expect(failure.detail.length).toBeGreaterThan(0)
    })
  })
})
