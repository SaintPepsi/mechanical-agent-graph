import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { WorktreeAddFailed, WorktreePathUnset, WorktreeSetupFailed } from "mag/graph-nodes/worktree-add/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/worktree-add/examples"
import { worktreeAdd } from "mag/graph-nodes/worktree-add/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

/** Like push-branch's `scriptedShell`: one canned reply per call, in order, recording argv and cwd. */
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

const WORK_ROOT = "/repo-worktrees/GH-173-run-1"
const RUN = testRunInfo({ workRoot: WORK_ROOT })

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService, run: RunInfoService = RUN) =>
  Effect.runSync(
    Effect.result(effect.pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, run)))
  )

describe("worktree-add", () => {
  test("the fixtures decode against worktree-add's own schemas", () => {
    if (!isSchemaHandle(worktreeAdd.input)) throw new Error("worktreeAdd.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(worktreeAdd.input)(example)
    if (!isSchemaHandle(worktreeAdd.success)) throw new Error("worktreeAdd.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(worktreeAdd.success)(example)
  })

  test("adds a detached worktree at RunInfo.workRoot, from the primary checkout", () => {
    const { calls, service } = scriptedShell([ok])
    const result = runWith(worktreeAdd.run({ base: "main" }), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ path: WORK_ROOT })
    expect(calls).toStrictEqual([
      { argv: ["git", "worktree", "add", "--detach", WORK_ROOT, "main"], cwd: "/repo" }
    ])
  })

  test("a declared setup command runs through sh -c, at workRoot, only when present", () => {
    const { calls, service } = scriptedShell([ok, ok])
    const result = runWith(worktreeAdd.run({ base: "main", setup: "bun install --frozen-lockfile" }), service)

    expect(Result.isSuccess(result)).toBe(true)
    expect(calls[1]).toStrictEqual({ argv: ["sh", "-c", "bun install --frozen-lockfile"], cwd: WORK_ROOT })
  })

  test("no setup field means no second shell call at all", () => {
    const { calls, service } = scriptedShell([ok])
    runWith(worktreeAdd.run({ base: "main" }), service)
    expect(calls).toHaveLength(1)
  })

  test("workRoot unset (equal to repoRoot) fails WorktreePathUnset before any git call", () => {
    const { calls, service } = scriptedShell([])
    const result = runWith(worktreeAdd.run({ base: "main" }), service, testRunInfo())

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(WorktreePathUnset)
    expect(calls).toHaveLength(0)
  })

  test("a non-zero `git worktree add` fails WorktreeAddFailed carrying the base and stderr", () => {
    const stderr = "fatal: 'main' is already used by worktree at '/repo'\n"
    const { service } = scriptedShell([exit(128, stderr)])
    const result = runWith(worktreeAdd.run({ base: "main" }), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(WorktreeAddFailed)
    const failure = result.failure as WorktreeAddFailed
    expect(failure.base).toBe("main")
    expect(failure.exitCode).toBe(128)
    expect(failure.stderr).toBe(stderr.trim())
  })

  test("a non-zero setup command fails WorktreeSetupFailed, and the add itself is not retried", () => {
    const { calls, service } = scriptedShell([ok, exit(1, "lockfile out of date\n")])
    const result = runWith(worktreeAdd.run({ base: "main", setup: "bun install --frozen-lockfile" }), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(WorktreeSetupFailed)
    expect(calls).toHaveLength(2)
  })
})
