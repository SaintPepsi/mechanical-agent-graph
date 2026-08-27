import { describe, expect, test } from "bun:test"
import { Data, Deferred, Effect, Fiber, Result } from "effect"
import { commitAgentLeftovers, commitPath, gitRead } from "mag/runtime/git"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"

/** Stand-in tagged errors, `porcelain.test.ts`/`escape.test.ts`'s idiom for a small runtime module: no real node's error class is this file's business. */
class TestGitFailed extends Data.TaggedError("TEST_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

class TestCommitFailed extends Data.TaggedError("TEST_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

/** In-order scripted shell, `build/graph-node.test.ts`'s idiom. */
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

const run = <A, E>(effect: Effect.Effect<A, E, never>, shell: ShellService) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provide(shellLayer(shell)))))

describe("gitRead", () => {
  test("trims stdout on exit 0", async () => {
    const { service } = scriptedShell([out("  abc123  \n")])
    const result = await run(gitRead(["git", "rev-parse", "HEAD"], undefined, (fields) => new TestGitFailed(fields)), service)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toBe("abc123")
  })

  test("fails the caller's own error, argv joined and stderr trimmed, on a non-zero exit", async () => {
    const { service } = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: bad revision\n" }])
    const result = await run(gitRead(["git", "rev-parse", "HEAD"], undefined, (fields) => new TestGitFailed(fields)), service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TestGitFailed)
    const failure = result.failure as TestGitFailed
    expect(failure.argv).toBe("git rev-parse HEAD")
    expect(failure.exitCode).toBe(128)
    expect(failure.stderr).toBe("fatal: bad revision")
  })

  test("the cwd option reaches the shell call", async () => {
    const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
    const service: ShellService = {
      run: (argv, options) => {
        calls.push({ argv: [...argv], cwd: options?.cwd })
        return Effect.succeed(out("aaa111\n"))
      }
    }
    await run(gitRead(["git", "rev-parse", "HEAD"], "/repo", (fields) => new TestGitFailed(fields)), service)
    expect(calls[0]!.cwd).toBe("/repo")
  })
})

describe("commitAgentLeftovers", () => {
  const commit = (
    shell: ShellService,
    sessions: readonly string[] = ["s1"],
    message = "GH-246: simplify"
  ) =>
    run(
      commitAgentLeftovers(
        undefined,
        message,
        sessions,
        (fields) => new TestGitFailed(fields),
        (fields) => new TestCommitFailed(fields)
      ),
      shell
    )

  test("no-ops on a clean tree: no add, no commit", async () => {
    const { calls, service } = scriptedShell([out("")])
    const result = await commit(service)
    expect(Result.isSuccess(result)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toStrictEqual(["git", "status", "--porcelain"])
  })

  test("a dirty probe that stages nothing (e.g. a submodule) is a no-op, not a failure", async () => {
    const { calls, service } = scriptedShell([out(" M sub\n"), out(""), { exitCode: 0, stdout: "", stderr: "" }])
    const result = await commit(service)
    expect(Result.isSuccess(result)).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[1]).toStrictEqual(["git", "add", "-A"])
    expect(calls[2]).toStrictEqual(["git", "diff", "--cached", "--quiet"])
  })

  test("stages and commits a genuinely dirty tree", async () => {
    const { calls, service } = scriptedShell([
      out("?? new.ts\n"),
      out(""),
      { exitCode: 1, stdout: "", stderr: "" },
      out("")
    ])
    const result = await commit(service, ["s1", "s2"], "GH-246: simplify")
    expect(Result.isSuccess(result)).toBe(true)
    expect(calls).toHaveLength(4)
    expect(calls[3]).toStrictEqual(["git", "commit", "-m", "GH-246: simplify"])
  })

  test("a failed status probe fails the caller's own git-failure constructor", async () => {
    const { service } = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }])
    const result = await commit(service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TestGitFailed)
  })

  test("a failed `git add` fails the caller's own commit-failure constructor, sessions attached", async () => {
    const { service } = scriptedShell([
      out("?? new.ts\n"),
      { exitCode: 128, stdout: "", stderr: "fatal: unable to write new index file\n" }
    ])
    const result = await commit(service, ["s1"])
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TestCommitFailed)
    const failure = result.failure as TestCommitFailed
    expect(failure.argv).toBe("git add -A")
    expect(failure.sessions).toStrictEqual(["s1"])
  })

  test("a failed `git commit` fails the caller's own commit-failure constructor, stdout and stderr both carried", async () => {
    const { service } = scriptedShell([
      out("?? new.ts\n"),
      out(""),
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "nothing to commit, working tree clean\n", stderr: "" }
    ])
    const result = await commit(service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TestCommitFailed)
    const failure = result.failure as TestCommitFailed
    expect(failure.argv).toBe("git commit -m <message>")
    expect(failure.stdout).toBe("nothing to commit, working tree clean")
  })
})

describe("commitPath", () => {
  const PATH = "docs/graph/envision/vision.md"
  const MESSAGE = "envision: vision committed by envision-mermaid"

  const commit = (shell: ShellService) =>
    run(
      commitPath(undefined, PATH, MESSAGE, ["s1"], (fields) => new TestGitFailed(fields), (fields) => new TestCommitFailed(fields)),
      shell
    )

  test("adds under a pathspec limited to the one path, never -A, and stops there when nothing staged", async () => {
    const { calls, service } = scriptedShell([out(""), { exitCode: 0, stdout: "", stderr: "" }])
    const result = await commit(service)
    expect(Result.isSuccess(result)).toBe(true)
    expect(calls).toStrictEqual([
      ["git", "add", "--", PATH],
      ["git", "diff", "--cached", "--quiet", "--", PATH]
    ])
  })

  test("stages and commits a genuinely new path, the commit itself pathspec-limited too", async () => {
    const { calls, service } = scriptedShell([out(""), { exitCode: 1, stdout: "", stderr: "" }, out("")])
    const result = await commit(service)
    expect(Result.isSuccess(result)).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[2]).toStrictEqual(["git", "commit", "-m", MESSAGE, "--", PATH])
  })

  test("a failed add fails the caller's own git-failure constructor, no sessions carried", async () => {
    const { service } = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: bad pathspec\n" }])
    const result = await commit(service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TestGitFailed)
    const failure = result.failure as TestGitFailed
    expect(failure.argv).toBe(`git add -- ${PATH}`)
  })

  test("a failed commit fails the caller's own commit-failure constructor, sessions attached", async () => {
    const { service } = scriptedShell([
      out(""),
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "fatal: empty ident name\n" }
    ])
    const result = await commit(service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TestCommitFailed)
    const failure = result.failure as TestCommitFailed
    expect(failure.sessions).toStrictEqual(["s1"])
    expect(failure.stderr).toBe("fatal: empty ident name")
  })
})

describe("index writes are serialised across concurrent callers", () => {
  test("two commitPath calls in Effect.all never interleave their git calls, even when the first one stalls mid-way", async () => {
    // A shell whose first `git add` blocks until released: the second caller, if not queued, would
    // run its own `add` in the gap. The call log proves it did not.
    const calls: string[] = []
    const release = Effect.runSync(Deferred.make<void>())
    let stalled = false
    const service: ShellService = {
      run: (argv) =>
        Effect.gen(function* () {
          const line = argv.join(" ")
          calls.push(line)
          if (line.startsWith("git add") && !stalled) {
            stalled = true
            yield* Deferred.await(release)
          }
          return line.startsWith("git diff") ? { exitCode: 1, stdout: "", stderr: "" } : out("")
        })
    }
    const commit = (path: string) =>
      commitPath(undefined, path, `commit ${path}`, ["s"], (fields) => new TestGitFailed(fields), (fields) => new TestCommitFailed(fields))

    const both = Effect.all([commit("a.md"), commit("b.md")], { concurrency: "unbounded" }).pipe(
      Effect.provide(shellLayer(service))
    )
    const fiber = Effect.runFork(both)
    // Let the first caller reach its stall and the second caller reach the permit.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toStrictEqual(["git add -- a.md"])
    Effect.runSync(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(fiber))

    expect(calls).toStrictEqual([
      "git add -- a.md",
      "git diff --cached --quiet -- a.md",
      "git commit -m commit a.md -- a.md",
      "git add -- b.md",
      "git diff --cached --quiet -- b.md",
      "git commit -m commit b.md -- b.md"
    ])
  })
})
