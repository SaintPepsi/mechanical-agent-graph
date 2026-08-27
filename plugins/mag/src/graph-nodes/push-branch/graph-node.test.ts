import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { PushDirty, PushEmpty, PushGitFailed, PushRejected } from "mag/graph-nodes/push-branch/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/push-branch/examples"
import { pushBranch } from "mag/graph-nodes/push-branch/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

/** Like branch's `scriptedShell`: one canned reply per call, in order, recording argv and cwd. */
const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const ok: ShellResult = { exitCode: 0, stdout: "", stderr: "" }
const exit = (exitCode: number, stderr = ""): ShellResult => ({ exitCode, stdout: "", stderr })

/** The two guard replies for a clean, ahead branch — every push-through test leads with these. */
const cleanAndAhead: readonly ShellResult[] = [ok, { exitCode: 0, stdout: "1\n", stderr: "" }]

const RUN = testRunInfo()

const INPUT = { remote: "origin", branch: "feat/gh-110", base: "main" }

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService) =>
  Effect.runSync(
    Effect.result(effect.pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, RUN)))
  )

describe("push-branch", () => {
  test("the fixtures decode against push-branch's own schemas", () => {
    if (!isSchemaHandle(pushBranch.input)) throw new Error("pushBranch.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(pushBranch.input)(example)
    if (!isSchemaHandle(pushBranch.success)) throw new Error("pushBranch.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(pushBranch.success)(example)
  })

  test("a clean push runs `git push -u` and reports the remote and branch", () => {
    const { calls, service } = scriptedShell([...cleanAndAhead, ok])
    const result = runWith(pushBranch.run(INPUT), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ remote: "origin", branch: "feat/gh-110" })
    expect(calls.map((call) => call.argv)).toStrictEqual([
      ["git", "status", "--porcelain"],
      ["git", "rev-list", "--count", "main..HEAD"],
      ["git", "push", "-u", "origin", "feat/gh-110"]
    ])
  })

  test("a rejected push fails as PushRejected carrying the remote's own message", () => {
    const stderr = "remote: error: GH006: Protected branch update failed\n"
    const { service } = scriptedShell([...cleanAndAhead, exit(1, stderr)])
    const result = runWith(pushBranch.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PushRejected)
    const failure = result.failure as PushRejected
    expect(failure.remote).toBe("origin")
    expect(failure.branch).toBe("feat/gh-110")
    expect(failure.exitCode).toBe(1)
    expect(failure.stderr).toBe("remote: error: GH006: Protected branch update failed")
  })

  test("a rejected push stops the node — exactly three git calls (both guards, then the push), never a retry", () => {
    const { calls, service } = scriptedShell([...cleanAndAhead, exit(1, "rejected\n")])
    runWith(pushBranch.run(INPUT), service)
    expect(calls).toHaveLength(3)
  })

  test("the push runs in RunInfo.workRoot", () => {
    const { calls, service } = scriptedShell([...cleanAndAhead, ok])
    runWith(pushBranch.run(INPUT), service)
    expect(calls.map((call) => call.cwd)).toStrictEqual(["/repo", "/repo", "/repo"])
  })

  test("RunInfo's default empty workRoot becomes an inherited cwd, not a path named \"\"", () => {
    const { calls, service } = scriptedShell([...cleanAndAhead, ok])
    Effect.runSync(
      Effect.result(pushBranch.run(INPUT).pipe(Effect.provide(shellLayer(service))))
    )
    expect(calls[0]?.cwd).toBeUndefined()
  })

  test("a dirty `git status --porcelain` reply fails PushDirty with the parsed paths, and neither rev-list nor push runs", () => {
    const { calls, service } = scriptedShell([{ exitCode: 0, stdout: " M src/foo.ts\n?? src/bar.ts\n", stderr: "" }])
    const result = runWith(pushBranch.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PushDirty)
    expect((result.failure as PushDirty).paths).toStrictEqual(["src/foo.ts", "src/bar.ts"])
    expect(calls).toHaveLength(1)
  })

  test("a clean status, then a zero rev-list count, fails PushEmpty naming branch and base, and push never runs", () => {
    const { calls, service } = scriptedShell([ok, { exitCode: 0, stdout: "0\n", stderr: "" }])
    const result = runWith(pushBranch.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PushEmpty)
    expect(result.failure).toStrictEqual(new PushEmpty({ branch: "feat/gh-110", base: "main" }))
    expect(calls).toHaveLength(2)
  })

  test("no scripted scenario's call log ever contains add, commit, or stash", () => {
    const scenarios: Array<readonly ShellResult[]> = [
      [{ exitCode: 0, stdout: " M src/foo.ts\n", stderr: "" }],
      [ok, { exitCode: 0, stdout: "0\n", stderr: "" }],
      [...cleanAndAhead, ok],
      [...cleanAndAhead, exit(1, "rejected\n")]
    ]
    for (const replies of scenarios) {
      const { calls, service } = scriptedShell(replies)
      runWith(pushBranch.run(INPUT), service)
      for (const call of calls) {
        expect(call.argv).not.toContain("add")
        expect(call.argv).not.toContain("commit")
        expect(call.argv).not.toContain("stash")
      }
    }
  })

  test("a clean status and a positive rev-list count reach the existing push call unchanged", () => {
    const { calls, service } = scriptedShell([ok, { exitCode: 0, stdout: "3\n", stderr: "" }, ok])
    const result = runWith(pushBranch.run(INPUT), service)

    expect(Result.isSuccess(result)).toBe(true)
    expect(calls[2]?.argv).toStrictEqual(["git", "push", "-u", "origin", "feat/gh-110"])
  })

  test("a non-zero `git status` exit fails PushGitFailed, not PushDirty", () => {
    const { service } = scriptedShell([exit(128, "fatal: not a git repository\n")])
    const result = runWith(pushBranch.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PushGitFailed)
    expect((result.failure as PushGitFailed).argv).toBe("git status --porcelain")
  })

  test("a non-zero or unparseable `git rev-list` reply fails PushGitFailed, not PushEmpty", () => {
    const { service } = scriptedShell([ok, { exitCode: 0, stdout: "not-a-number\n", stderr: "" }])
    const result = runWith(pushBranch.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PushGitFailed)
    expect((result.failure as PushGitFailed).argv).toBe("git rev-list --count main..HEAD")
  })
})
