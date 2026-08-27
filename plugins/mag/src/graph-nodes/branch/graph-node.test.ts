import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { BranchCheckoutFailed, BranchCreateFailed } from "mag/graph-nodes/branch/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/branch/examples"
import { branch } from "mag/graph-nodes/branch/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

/**
 * Like fetch-ticket's `stubShell`, but scripted: one canned reply per call, in order, because
 * this node's probe and its checkout must answer differently within one run. Records the cwd too —
 * the checkout landing in `RunInfo.workRoot` is part of the contract under test.
 */
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

const RUN = testRunInfo()

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService) =>
  Effect.runSync(
    Effect.result(effect.pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, RUN)))
  )

describe("branch", () => {
  test("the fixtures decode against branch's own schemas", () => {
    if (!isSchemaHandle(branch.input)) throw new Error("branch.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(branch.input)(example)
    if (!isSchemaHandle(branch.success)) throw new Error("branch.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(branch.success)(example)
  })

  test("an existing branch is checked out plain — the branch-creating form never runs", () => {
    const { calls, service } = scriptedShell([ok, ok])
    const result = runWith(branch.run({ branch: "fix/gh-98", base: "main" }), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ branch: "fix/gh-98", created: false })
    expect(calls.map((call) => call.argv)).toStrictEqual([
      ["git", "rev-parse", "--verify", "-q", "refs/heads/fix/gh-98"],
      ["git", "checkout", "fix/gh-98"]
    ])
  })

  test("a missing branch is created from the base and left checked out", () => {
    const { calls, service } = scriptedShell([exit(1), ok])
    const result = runWith(branch.run({ branch: "fix/gh-98", base: "main" }), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ branch: "fix/gh-98", created: true })
    expect(calls[1]?.argv).toStrictEqual(["git", "checkout", "-b", "fix/gh-98", "main"])
  })

  test("a failed checkout of an existing branch fails the node — it never falls through to creation", () => {
    const { calls, service } = scriptedShell([ok, exit(1, "hook exited non-zero\n")])
    const result = runWith(branch.run({ branch: "fix/gh-98", base: "main" }), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BranchCheckoutFailed)
    expect((result.failure as BranchCheckoutFailed).exitCode).toBe(1)
    expect((result.failure as BranchCheckoutFailed).stderr).toBe("hook exited non-zero")
    expect(calls).toHaveLength(2)
  })

  test("a failed creation is BranchCreateFailed, carrying the base that did not resolve", () => {
    const { service } = scriptedShell([exit(1), exit(128, "fatal: not a valid object name: 'nope'\n")])
    const result = runWith(branch.run({ branch: "fix/gh-98", base: "nope" }), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BranchCreateFailed)
    expect((result.failure as BranchCreateFailed).base).toBe("nope")
  })

  test("every git call runs in RunInfo.workRoot", () => {
    const { calls, service } = scriptedShell([ok, ok])
    runWith(branch.run({ branch: "fix/gh-98", base: "main" }), service)
    expect(calls.map((call) => call.cwd)).toStrictEqual(["/repo", "/repo"])
  })

  test("RunInfo's default empty workRoot becomes an inherited cwd, not a path named \"\"", () => {
    const { calls, service } = scriptedShell([ok, ok])
    Effect.runSync(
      Effect.result(branch.run({ branch: "fix/gh-98", base: "main" }).pipe(Effect.provide(shellLayer(service))))
    )
    expect(calls[0]?.cwd).toBeUndefined()
  })
})
