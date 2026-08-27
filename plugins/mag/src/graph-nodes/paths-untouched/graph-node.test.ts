import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { PathsTouched, PathsUntouchedGitFailed } from "mag/graph-nodes/paths-untouched/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/paths-untouched/examples"
import { pathsUntouched } from "mag/graph-nodes/paths-untouched/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

const recordingShell = (reply: ShellResult) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const INPUT = { paths: ["src/limiter.test.ts", "src/sync.test.ts"], fromSha: "aaa111", toSha: "bbb222" }

const runWith = (service: ShellService, input = INPUT) =>
  Effect.runPromise(
    Effect.result(
      pathsUntouched.run(input).pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, testRunInfo()))
    )
  )

describe("paths-untouched", () => {
  test("the fixtures decode against paths-untouched's own schemas", () => {
    if (!isSchemaHandle(pathsUntouched.input)) throw new Error("pathsUntouched.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(pathsUntouched.input)(example)
    if (!isSchemaHandle(pathsUntouched.success)) throw new Error("pathsUntouched.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(pathsUntouched.success)(example)
  })

  test("a range that touches only other files passes, read as one name-only diff in workRoot", async () => {
    const { calls, service } = recordingShell({ exitCode: 0, stdout: "src/limiter.ts\nsrc/other.ts\n", stderr: "" })
    const result = await runWith(service)

    expect(Result.isSuccess(result)).toBe(true)
    expect(calls).toStrictEqual([{ argv: ["git", "diff", "--name-only", "aaa111", "bbb222"], cwd: "/repo" }])
  })

  test("a range that touches a forbidden path is PathsTouched, naming exactly the forbidden paths it reached", async () => {
    const { service } = recordingShell({
      exitCode: 0,
      stdout: "src/limiter.ts\nsrc/sync.test.ts\nsrc/limiter.test.ts.bak\n",
      stderr: ""
    })
    const result = await runWith(service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(
      new PathsTouched({ paths: ["src/sync.test.ts"], fromSha: "aaa111", toSha: "bbb222" })
    )
  })

  test("a failing diff is PathsUntouchedGitFailed, never a silent pass", async () => {
    const { service } = recordingShell({ exitCode: 128, stdout: "", stderr: "fatal: bad object bbb222\n" })
    const result = await runWith(service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PathsUntouchedGitFailed)
    expect((result.failure as PathsUntouchedGitFailed).exitCode).toBe(128)
  })
})
