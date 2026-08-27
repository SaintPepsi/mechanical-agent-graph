import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { WorktreePathUnset, WorktreeRemoveFailed } from "mag/graph-nodes/worktree-remove/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/worktree-remove/examples"
import { worktreeRemove } from "mag/graph-nodes/worktree-remove/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

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

describe("worktree-remove", () => {
  test("the fixtures decode against worktree-remove's own schemas", () => {
    if (!isSchemaHandle(worktreeRemove.input)) throw new Error("worktreeRemove.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(worktreeRemove.input)(example)
    if (!isSchemaHandle(worktreeRemove.success)) throw new Error("worktreeRemove.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(worktreeRemove.success)(example)
  })

  test("removes the given path from the primary checkout, never from inside it", () => {
    const { calls, service } = scriptedShell([ok])
    const result = runWith(worktreeRemove.run({ path: WORK_ROOT }), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ path: WORK_ROOT })
    expect(calls).toStrictEqual([{ argv: ["git", "worktree", "remove", WORK_ROOT], cwd: "/repo" }])
  })

  test("--force never appears in any argv this node produces, on success or failure", () => {
    const scenarios: Array<readonly ShellResult[]> = [[ok], [exit(128, "contains modified or untracked files\n")]]
    for (const replies of scenarios) {
      const { calls, service } = scriptedShell(replies)
      runWith(worktreeRemove.run({ path: WORK_ROOT }), service)
      for (const call of calls) expect(call.argv).not.toContain("--force")
    }
  })

  test("a non-zero `git worktree remove` fails WorktreeRemoveFailed, and the tree is left alone", () => {
    const stderr = "fatal: '/repo-worktrees/GH-173-run-1' contains modified or untracked files, use --force\n"
    const { service } = scriptedShell([exit(128, stderr)])
    const result = runWith(worktreeRemove.run({ path: WORK_ROOT }), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(WorktreeRemoveFailed)
    const failure = result.failure as WorktreeRemoveFailed
    expect(failure.path).toBe(WORK_ROOT)
    expect(failure.stderr).toBe(stderr.trim())
  })

  test("a path equal to repoRoot refuses to remove the primary checkout, no git call made", () => {
    const { calls, service } = scriptedShell([])
    const result = runWith(worktreeRemove.run({ path: "/repo" }), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(WorktreePathUnset)
    expect(calls).toHaveLength(0)
  })
})
