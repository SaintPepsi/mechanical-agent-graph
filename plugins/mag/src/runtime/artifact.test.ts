import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import { writeArtifact } from "mag/runtime/artifact"
import { platform } from "mag/runtime/platform"

/** Deletes a fixture directory, and only a fixture directory: anything outside tmpdir is refused. */
const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

/** A real, disposable directory standing in for a run root, `design/graph-node.test.ts`'s `withDirs` idiom. */
const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "artifact-"))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

const write = (runRoot: string, prefix: string, content: string, extension?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* writeArtifact(fs, runRoot, prefix, content, extension)
    }).pipe(Effect.provide(platform))
  )

describe("writeArtifact", () => {
  test("the first call names pass 1", () =>
    withRunRoot(async (runRoot) => {
      const path = await write(runRoot, "build", "the summary")
      expect(path).toBe(`${runRoot}/build-1.md`)
      expect(readFileSync(path, "utf8")).toBe("the summary")
    }))

  test("a second call against the same runRoot/prefix names pass 2", () =>
    withRunRoot(async (runRoot) => {
      const first = await write(runRoot, "review-diff", "no blocking findings")
      const second = await write(runRoot, "review-diff", "one blocking finding")
      expect(first).toBe(`${runRoot}/review-diff-1.md`)
      expect(second).toBe(`${runRoot}/review-diff-2.md`)
      expect(readFileSync(second, "utf8")).toBe("one blocking finding")
    }))

  test("a different prefix in the same runRoot starts its own count at 1", () =>
    withRunRoot(async (runRoot) => {
      await write(runRoot, "build", "summary one")
      const reviewPath = await write(runRoot, "review-diff", "findings one")
      expect(reviewPath).toBe(`${runRoot}/review-diff-1.md`)
    }))

  test("a `dispute-` file does not inflate the next `build-` count — the mechanical trap the prefix choice avoids", () =>
    withRunRoot(async (runRoot) => {
      const buildOne = await write(runRoot, "build", "summary one")
      const disputeOne = await write(runRoot, "dispute", "the argument")
      const buildTwo = await write(runRoot, "build", "summary two")
      expect(buildOne).toBe(`${runRoot}/build-1.md`)
      expect(disputeOne).toBe(`${runRoot}/dispute-1.md`)
      expect(buildTwo).toBe(`${runRoot}/build-2.md`)
    }))

  test("an extension names a non-markdown artifact, and a `diff-` file does not inflate a `review-diff-` count", () =>
    withRunRoot(async (runRoot) => {
      const diffOne = await write(runRoot, "diff", "--- a/x.ts\n+++ b/x.ts\n", "patch")
      const reviewOne = await write(runRoot, "review-diff", "no blocking findings")
      const diffTwo = await write(runRoot, "diff", "--- a/y.ts\n+++ b/y.ts\n", "patch")
      expect(diffOne).toBe(`${runRoot}/diff-1.patch`)
      expect(reviewOne).toBe(`${runRoot}/review-diff-1.md`)
      expect(diffTwo).toBe(`${runRoot}/diff-2.patch`)
      expect(readFileSync(diffOne, "utf8")).toBe("--- a/x.ts\n+++ b/x.ts\n")
    }))

  test("the directory is created when it doesn't yet exist", () =>
    withRunRoot(async (base) => {
      const runRoot = join(base, "nested", "run")
      expect(existsSync(runRoot)).toBe(false)
      const path = await write(runRoot, "build", "the summary")
      expect(path).toBe(`${runRoot}/build-1.md`)
      expect(readdirSync(runRoot)).toStrictEqual(["build-1.md"])
    }))
})
