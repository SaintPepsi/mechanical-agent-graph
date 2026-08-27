import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { AssertRedHeadMoved, AssertRedNoTests } from "mag/graph-nodes/assert-red/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/assert-red/examples"
import { assertRed } from "mag/graph-nodes/assert-red/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { liveShell, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

/**
 * The exit code is the whole verdict, so the command under test is a `case` on `$1` that exits
 * with the code its name asks for: the classification is then proven against a real `sh`, not a
 * scripted reply that would agree with whatever mapping the node happened to implement.
 */
const COMMAND = "case \"$1\" in *red*) exit 1;; *broken*) exit 2;; *) exit 0;; esac"

/** Git is answered from a script; everything else reaches the real shell, so `$1` is really bound by `sh`. */
const gitThenLive = (head: string) => {
  const calls: string[][] = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push([...argv])
      if (argv.join(" ") === "git rev-parse HEAD") return Effect.succeed({ exitCode: 0, stdout: `${head}\n`, stderr: "" })
      return liveShell.run(argv, options)
    }
  }
  return { calls, service }
}

const runWith = (input: Parameters<typeof assertRed.run>[0], service: ShellService) =>
  Effect.runPromise(
    Effect.result(
      assertRed.run(input).pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, testRunInfo({ workRoot: "" })))
    )
  )

describe("assert-red", () => {
  test("the fixtures decode against assert-red's own schemas", () => {
    if (!isSchemaHandle(assertRed.input)) throw new Error("assertRed.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(assertRed.input)(example)
    if (!isSchemaHandle(assertRed.success)) throw new Error("assertRed.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(assertRed.success)(example)
  })

  test("exit 0 is green, exit 1 is red, any other exit is broken, each path judged on its own run", async () => {
    const { calls, service } = gitThenLive("aaa111")
    const result = await runWith(
      { testPaths: ["a.red.test", "b.green.test", "c.broken.test", "d.red.test"], sha: "aaa111", command: COMMAND },
      service
    )

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({
      red: ["a.red.test", "d.red.test"],
      green: ["b.green.test"],
      broken: ["c.broken.test"]
    })
    // One `sh -c <command> sh <path>` per path, so `$1` is that path and nothing else.
    expect(calls.slice(1)).toStrictEqual([
      ["sh", "-c", COMMAND, "sh", "a.red.test"],
      ["sh", "-c", COMMAND, "sh", "b.green.test"],
      ["sh", "-c", COMMAND, "sh", "c.broken.test"],
      ["sh", "-c", COMMAND, "sh", "d.red.test"]
    ])
  })

  test("a tree that moved off the declared sha is AssertRedHeadMoved, and no test command runs", async () => {
    const { calls, service } = gitThenLive("bbb222")
    const result = await runWith({ testPaths: ["a.red.test"], sha: "aaa111", command: COMMAND }, service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new AssertRedHeadMoved({ expected: "aaa111", observed: "bbb222" }))
    expect(calls).toStrictEqual([["git", "rev-parse", "HEAD"]])
  })

  test("an empty test list is AssertRedNoTests before any read at all", async () => {
    const { calls, service } = gitThenLive("aaa111")
    const result = await runWith({ testPaths: [], sha: "aaa111", command: COMMAND }, service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(AssertRedNoTests)
    expect(calls).toStrictEqual([])
  })
})
