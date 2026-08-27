import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { BaseRefMissing, BaseRemoteMissing, BaseRemoteUnavailable } from "mag/graph-nodes/resolve-base/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/resolve-base/examples"
import { resolveBase } from "mag/graph-nodes/resolve-base/graph-node"
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

const exit = (exitCode: number, stdout = "", stderr = ""): ShellResult => ({ exitCode, stdout, stderr })

const RUN = testRunInfo()

const INPUT = { base: "main", remote: "origin" }

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService) =>
  Effect.runSync(
    Effect.result(effect.pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, RUN)))
  )

describe("resolve-base", () => {
  test("the fixtures decode against resolve-base's own schemas", () => {
    if (!isSchemaHandle(resolveBase.input)) throw new Error("resolveBase.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(resolveBase.input)(example)
    if (!isSchemaHandle(resolveBase.success)) throw new Error("resolveBase.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(resolveBase.success)(example)
  })

  test("both probes succeed — success is the base and the local probe's own sha", () => {
    const { calls, service } = scriptedShell([
      exit(0, "aaa111\n"),
      exit(0, "aaa111\trefs/heads/main\n")
    ])
    const result = runWith(resolveBase.run(INPUT), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ base: "main", sha: "aaa111" })
    // The full-ref pattern in BOTH probes is load-bearing: `ls-remote` tail-matches a bare name
    // against ref components (`main` matches `refs/heads/release/main`), so a bare-name pattern
    // turns the existence check into a suffix glob. This exact-argv
    // assertion is what pins the exact-ref form.
    expect(calls.map((call) => call.argv)).toStrictEqual([
      ["git", "rev-parse", "--verify", "-q", "refs/heads/main"],
      ["git", "ls-remote", "--exit-code", "--heads", "origin", "refs/heads/main"]
    ])
  })

  test("the local probe exiting 1 fails BaseRefMissing, and no `git ls-remote` runs — the cheap check first, no network on a typo", () => {
    const { calls, service } = scriptedShell([exit(1)])
    const result = runWith(resolveBase.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new BaseRefMissing({ base: "main" }))
    expect(calls).toHaveLength(1)
  })

  test("the remote probe exiting 2 fails BaseRemoteMissing", () => {
    const { service } = scriptedShell([exit(0, "aaa111\n"), exit(2)])
    const result = runWith(resolveBase.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new BaseRemoteMissing({ base: "main", remote: "origin" }))
  })

  test("the remote probe exiting 128 (unreachable) fails BaseRemoteUnavailable carrying the stderr verbatim, never BaseRemoteMissing", () => {
    const stderr = "fatal: unable to access 'origin': Could not resolve host\n"
    const { service } = scriptedShell([exit(0, "aaa111\n"), exit(128, "", stderr)])
    const result = runWith(resolveBase.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BaseRemoteUnavailable)
    const failure = result.failure as BaseRemoteUnavailable
    expect(failure.exitCode).toBe(128)
    expect(failure.stderr).toBe("fatal: unable to access 'origin': Could not resolve host")
  })

  test("both probes run in RunInfo.repoRoot", () => {
    const { calls, service } = scriptedShell([exit(0, "aaa111\n"), exit(0, "aaa111\trefs/heads/main\n")])
    runWith(resolveBase.run(INPUT), service)
    expect(calls.map((call) => call.cwd)).toStrictEqual(["/repo", "/repo"])
  })
})
