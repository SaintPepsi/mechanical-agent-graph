import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Data, Effect, FileSystem, Layer, Result } from "effect"
import { platform } from "mag/runtime/platform"
import { record, requireRunRoot } from "mag/runtime/records"
import { RunInfo } from "mag/runtime/run-info"
import { Shell, type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

/** Stand-in tagged errors, `git.test.ts`'s idiom: no real node's error class is this file's business. */
class TestMissing extends Data.TaggedError("TEST_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

class TestCopyFailed extends Data.TaggedError("TEST_COPY_FAILED")<{
  readonly path: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}

class TestGitFailed extends Data.TaggedError("TEST_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

class TestRunRootMissing extends Data.TaggedError("TEST_RUN_ROOT_MISSING")<{}> {}

class TestCommitFailed extends Data.TaggedError("TEST_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

const ok = (): ShellResult => ({ exitCode: 0, stdout: "", stderr: "" })

/** In-order scripted shell, `git.test.ts`'s idiom. */
const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: string[][] = []
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

/** `git add` ok, `git diff --cached --quiet` exit 1 (staged), `git commit` ok. */
const commitsCleanly = () => scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, ok()])

const MESSAGE = "test: record committed"

const runWith = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>, run: ReturnType<typeof testRunInfo>, shell: ShellService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(platform, shellLayer(shell))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

const callWith = (path: string, before: string, sessions: readonly string[] = ["s1"]) =>
  record(path, {
    before,
    message: MESSAGE,
    sessions,
    onMissing: (fields) => new TestMissing(fields),
    onCopyFailed: (fields) => new TestCopyFailed(fields),
    onGitFailure: (fields) => new TestGitFailed(fields),
    onCommitFailure: (fields) => new TestCommitFailed(fields)
  })

/** A disposable repo checkout plus a disposable run root, `design/graph-node.test.ts`'s `withDirs`
 *  fixture shape — both real directories, since the copy under test is a real filesystem write. */
const withDirs = async <T>(fn: (repoRoot: string, runRoot: string) => Promise<T>): Promise<T> => {
  const base = mkdtempSync(join(tmpdir(), "records-"))
  const repoRoot = join(base, "repo")
  const runRoot = join(base, "run")
  mkdirSync(repoRoot, { recursive: true })
  mkdirSync(runRoot, { recursive: true })
  try {
    return await fn(repoRoot, runRoot)
  } finally {
    await removeDir(base)
  }
}

describe("record", () => {
  test("a missing file fails onMissing, carrying the path and sessions", () =>
    withDirs(async (repoRoot, runRoot) => {
      const path = join(repoRoot, "note.md")
      const result = await runWith(callWith(path, ""), testRunInfo({ repoRoot, workRoot: repoRoot, runRoot }), commitsCleanly().service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestMissing)
      const failure = result.failure as TestMissing
      expect(failure.path).toBe(path)
      expect(failure.sessions).toStrictEqual(["s1"])
      expect(existsSync(runRoot + "/note.md")).toBe(false)
    }))

  test("a blank file fails onMissing too", () =>
    withDirs(async (repoRoot, runRoot) => {
      const path = join(repoRoot, "note.md")
      writeFileSync(path, "  \n")
      const result = await runWith(callWith(path, ""), testRunInfo({ repoRoot, workRoot: repoRoot, runRoot }), commitsCleanly().service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestMissing)
    }))

  test("a file unchanged from its pre-dispatch snapshot fails onMissing too", () =>
    withDirs(async (repoRoot, runRoot) => {
      const path = join(repoRoot, "note.md")
      writeFileSync(path, "same content\n")
      const result = await runWith(
        callWith(path, "same content\n"),
        testRunInfo({ repoRoot, workRoot: repoRoot, runRoot }),
        commitsCleanly().service
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestMissing)
    }))

  test("a present, changed file is copied into the run root under its own basename, no git call under the default run-root policy", () =>
    withDirs(async (repoRoot, runRoot) => {
      const path = join(repoRoot, "note.md")
      writeFileSync(path, "fresh content\n")
      const { calls, service } = commitsCleanly()
      const result = await runWith(callWith(path, ""), testRunInfo({ repoRoot, workRoot: repoRoot, runRoot }), service)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ written: "fresh content\n", copyPath: `${runRoot}/note.md` })
      expect(readFileSync(`${runRoot}/note.md`, "utf8")).toBe("fresh content\n")
      expect(calls).toHaveLength(0)
    }))

  test("the committed policy stages, diffs, and commits the repo path, pathspec-scoped, after the copy", () =>
    withDirs(async (repoRoot, runRoot) => {
      const path = join(repoRoot, "note.md")
      writeFileSync(path, "fresh content\n")
      const { calls, service } = commitsCleanly()
      const result = await runWith(
        callWith(path, ""),
        testRunInfo({ repoRoot, workRoot: repoRoot, runRoot, records: "committed" }),
        service
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(readFileSync(`${runRoot}/note.md`, "utf8")).toBe("fresh content\n")
      expect(calls).toStrictEqual([
        ["git", "add", "--", path],
        ["git", "diff", "--cached", "--quiet", "--", path],
        ["git", "commit", "-m", MESSAGE, "--", path]
      ])
    }))

  test("a committed policy that finds nothing staged makes no commit call", () =>
    withDirs(async (repoRoot, runRoot) => {
      const path = join(repoRoot, "note.md")
      writeFileSync(path, "fresh content\n")
      const { calls, service } = scriptedShell([ok(), { exitCode: 0, stdout: "", stderr: "" }])
      const result = await runWith(
        callWith(path, ""),
        testRunInfo({ repoRoot, workRoot: repoRoot, runRoot, records: "committed" }),
        service
      )

      expect(Result.isSuccess(result)).toBe(true)
      expect(calls).toHaveLength(2)
    }))

  test("an empty run root fails onCopyFailed with 'run root missing', before any git call", () =>
    withDirs(async (repoRoot) => {
      const path = join(repoRoot, "note.md")
      writeFileSync(path, "fresh content\n")
      const { calls, service } = commitsCleanly()
      const result = await runWith(
        callWith(path, ""),
        testRunInfo({ repoRoot, workRoot: repoRoot, runRoot: "", records: "committed" }),
        service
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestCopyFailed)
      expect((result.failure as TestCopyFailed).detail).toBe("run root missing")
      expect(calls).toHaveLength(0)
    }))

  test("a run root that can't be made fails onCopyFailed, carrying the path, a non-empty detail, and the sessions", () =>
    withDirs(async (repoRoot, runRoot) => {
      const path = join(repoRoot, "note.md")
      writeFileSync(path, "fresh content\n")
      // A real file sitting where a path component of the run root needs to be a directory —
      // `design/graph-node.test.ts`'s own cheap reproduction of a copy failure.
      const blocker = `${runRoot}/blocker`
      writeFileSync(blocker, "not a directory")
      const brokenRoot = `${blocker}/subdir`

      const result = await runWith(callWith(path, ""), testRunInfo({ repoRoot, workRoot: repoRoot, runRoot: brokenRoot }), commitsCleanly().service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestCopyFailed)
      const failure = result.failure as TestCopyFailed
      expect(failure.path).toBe(`${brokenRoot}/note.md`)
      expect(failure.detail.length).toBeGreaterThan(0)
      expect(failure.sessions).toStrictEqual(["s1"])
    }))
})

describe("requireRunRoot", () => {
  const runWithRunInfo = (run: ReturnType<typeof testRunInfo>) =>
    Effect.runPromise(Effect.result(requireRunRoot(() => new TestRunRootMissing()).pipe(Effect.provideService(RunInfo, run))))

  test("an empty run root fails the caller's own tagged error", async () => {
    const result = await runWithRunInfo(testRunInfo({ runRoot: "" }))

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TestRunRootMissing)
  })

  test("a real run root passes through", async () => {
    const result = await runWithRunInfo(testRunInfo({ runRoot: "/repo/.claude/graph/run-1" }))

    expect(Result.isSuccess(result)).toBe(true)
  })
})
