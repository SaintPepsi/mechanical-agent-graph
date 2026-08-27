import { describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Data, Effect, Result } from "effect"
import { candidates, declaring, type Manifest, readManifests } from "mag/runtime/manifest"
import { platform } from "mag/runtime/platform"

/** `readManifests`/`declaring` against real temp trees — boundary fixtures, and disconfirming
 *  unreadable/malformed cases. A scripted `FileSystem` would only prove this file's own assumptions
 *  about `glob`/`readFileString`; the facts this module relies on were probed against
 *  the real thing, so these tests run against it too. */

class TestUnreadable extends Data.TaggedError("TEST_UNREADABLE")<{ readonly path: string; readonly detail: string }> {}
class TestMalformed extends Data.TaggedError("TEST_MALFORMED")<{ readonly path: string; readonly detail: string }> {}

const run = (root: string) =>
  Effect.runPromise(
    Effect.result(
      readManifests(root, (failure) => new TestUnreadable(failure), (failure) => new TestMalformed(failure)).pipe(
        Effect.provide(platform)
      )
    )
  )

const tempRepo = (): string => mkdtempSync(join(tmpdir(), "manifest-test-"))

/** Fixture-only cleanup, scoped to the temp trees `tempRepo` creates above. Walks by hand rather than
 *  a recursive-remove flag: refuses anything outside the OS temp dir, so a misconfigured or empty
 *  path can never widen the blast radius. */
const removeDir = (path: string): void => {
  if (path.trim() === "" || !path.startsWith(tmpdir())) {
    throw new Error(`removeDir: refusing to remove a non-temp path: ${path}`)
  }
  const stat = lstatSync(path)
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of readdirSync(path)) removeDir(join(path, entry))
    rmdirSync(path)
  } else {
    unlinkSync(path)
  }
}

describe("readManifests", () => {
  test("no manifest anywhere is a clean non-match, not a failure", async () => {
    const repo = tempRepo()
    try {
      const result = await run(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toEqual([])
    } finally {
      removeDir(repo)
    }
  })

  test("a dependency in `dependencies` matches", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", dependencies: { svelte: "^5" } }))
      const result = await run(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(declaring(result.success, "svelte").map((manifest) => manifest.path)).toEqual(["package.json"])
    } finally {
      removeDir(repo)
    }
  })

  test("the same name in `devDependencies` matches — a probe treats both fields the same", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", devDependencies: { effect: "beta" } }))
      const result = await run(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(declaring(result.success, "effect").map((manifest) => manifest.path)).toEqual(["package.json"])
    } finally {
      removeDir(repo)
    }
  })

  test("a nested manifest the root never declares as a workspace still matches, with its own path", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }))
      mkdirSync(join(repo, "packages", "app", "deep"), { recursive: true })
      writeFileSync(join(repo, "packages", "app", "deep", "package.json"), JSON.stringify({ name: "app", dependencies: { svelte: "^5" } }))
      const result = await run(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(declaring(result.success, "svelte").map((manifest) => manifest.path)).toEqual(["packages/app/deep/package.json"])
    } finally {
      removeDir(repo)
    }
  })

  test("a nested manifest matches even when the root has none at all", async () => {
    const repo = tempRepo()
    try {
      mkdirSync(join(repo, "apps", "web"), { recursive: true })
      writeFileSync(join(repo, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { svelte: "^5" } }))
      const result = await run(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.map((manifest) => manifest.path)).toEqual(["apps/web/package.json"])
    } finally {
      removeDir(repo)
    }
  })

  test("manifests under `node_modules`, at any depth, are pruned from the walk", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }))
      mkdirSync(join(repo, "node_modules", "dep"), { recursive: true })
      writeFileSync(join(repo, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", dependencies: { svelte: "^5" } }))
      mkdirSync(join(repo, "packages", "app", "node_modules", "inner"), { recursive: true })
      writeFileSync(join(repo, "packages", "app", "node_modules", "inner", "package.json"), JSON.stringify({ name: "inner", dependencies: { svelte: "^5" } }))
      const result = await run(repo)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.map((manifest) => manifest.path)).toEqual(["package.json"])
      expect(declaring(result.success, "svelte")).toEqual([])
    } finally {
      removeDir(repo)
    }
  })

  test("disconfirming: a `package.json` that is a directory fails `onUnreadable`, not a clean non-match", async () => {
    const repo = tempRepo()
    try {
      mkdirSync(join(repo, "package.json"))
      const result = await run(repo)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestUnreadable)
      expect((result.failure as TestUnreadable).detail).toBe("BadResource")
    } finally {
      removeDir(repo)
    }
  })

  test("disconfirming: a manifest that reads fine but isn't JSON fails `onMalformed`", async () => {
    const repo = tempRepo()
    try {
      writeFileSync(join(repo, "package.json"), "not json")
      const result = await run(repo)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestMalformed)
    } finally {
      removeDir(repo)
    }
  })
})

/** `candidates` is pure — no `FileSystem`, no temp trees, just `Manifest` values built
 *  by hand. `dependencies` is empty throughout: `candidates` never reads it, only `path` and `name`. */
const manifestAt = (path: string, name: string | null = null): Manifest => ({ path, name, dependencies: new Set() })

describe("candidates", () => {
  test("the root manifest is always a candidate, regardless of text", () => {
    const root = manifestAt("package.json", "root")
    expect(candidates([root], "unrelated ticket about something else entirely")).toEqual([root])
  })

  test("a nested manifest is a candidate when the text names its full directory path", () => {
    const nested = manifestAt("plugins/mag/projects/graph-viewer/package.json", "graph-viewer")
    const text = "Fix a bug under plugins/mag/projects/graph-viewer's renderer."
    expect(candidates([nested], text)).toEqual([nested])
  })

  test("a nested manifest is a candidate when the text names only a trailing suffix of its directory path", () => {
    const nested = manifestAt("plugins/mag/projects/graph-viewer/package.json", "graph-viewer")
    expect(candidates([nested], "the graph-viewer canvas is misaligned")).toEqual([nested])
  })

  test("a nested manifest is a candidate when the text names its package `name`, not its path", () => {
    const nested = manifestAt("plugins/mag/projects/graph-viewer/package.json", "graph-viewer")
    expect(candidates([nested], "graph-viewer's package.json needs a new dependency")).toEqual([nested])
  })

  test("a nested manifest naming neither its path nor its name is excluded — a ticket about runtime must not match the viewer", () => {
    const nested = manifestAt("plugins/mag/projects/graph-viewer/package.json", "graph-viewer")
    expect(candidates([nested], "fix a bug in plugins/mag/src/runtime/manifest.ts")).toEqual([])
  })
})
