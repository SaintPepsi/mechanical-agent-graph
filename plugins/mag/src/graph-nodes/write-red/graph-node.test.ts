import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import {
  WriteRedHeadMoved,
  WriteRedNoTests,
  WriteRedPathsMissing,
  WriteRedPathsUndeclared,
  WriteRedWorkdirDirty
} from "mag/graph-nodes/write-red/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/write-red/examples"
import { writeRed } from "mag/graph-nodes/write-red/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

/**
 * The sequence for a session that leaves its tests uncommitted, `build/graph-node.test.ts`'s
 * in-order idiom: the head gate, the pre-dispatch dirty probe, [the session], the leftover probe
 * (dirty), `add -A`, the staged-index check (exit 1: something staged), `commit`, the changed-paths
 * read, the post-commit sha.
 */
const committingReplies = (changed: string) => [
  out("aaa111\n"),
  out(""),
  out("?? src/limiter.test.ts\n"),
  out(""),
  { exitCode: 1, stdout: "", stderr: "" },
  out(""),
  out(changed),
  out("ccc333\n")
]

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

/** A session declaring a fixed partition of what it wrote. */
const declaringAgent = (verdict: { testPaths: readonly string[]; stubPaths: readonly string[] }) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({ verdict: verdict as A, result: {}, sessions: ["red-session"], costUsd: 0.35, attempts: 1 } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const DECLARED = { testPaths: ["src/limiter.test.ts"], stubPaths: ["src/limiter.ts"] }

const runWith = (input: Parameters<typeof writeRed.run>[0], shell: ShellService, agent: ClaudeAgentService) =>
  Effect.runPromise(
    Effect.result(
      writeRed.run(input).pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, testRunInfo())
      )
    )
  )

describe("write-red", () => {
  test("the fixtures decode against write-red's own schemas", () => {
    if (!isSchemaHandle(writeRed.input)) throw new Error("writeRed.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(writeRed.input)(example)
    if (!isSchemaHandle(writeRed.success)) throw new Error("writeRed.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(writeRed.success)(example)
  })

  test("a declaration that matches the commit exactly succeeds with the post-commit sha, and the commit names the run's ticket", async () => {
    const shell = scriptedShell(committingReplies("src/limiter.ts\nsrc/limiter.test.ts\n"))
    const agent = declaringAgent(DECLARED)
    const result = await runWith(inputExamples[0]!, shell.service, agent.service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ ...DECLARED, redSha: "ccc333", sessions: ["red-session"], costUsd: 0.35, sessionRef: "red-session" })
    expect(shell.calls[5]!.slice(0, 3)).toStrictEqual(["git", "commit", "-m"])
    expect(shell.calls[5]![3]).toStartWith("test(GH-98): red tests")
    expect(shell.calls[6]).toStrictEqual(["git", "diff", "--name-only", "aaa111", "HEAD"])
  })

  test("the prompt carries the plan, the red-on-assertion instruction, and the addendum verbatim; names no suite command", async () => {
    const agent = declaringAgent(DECLARED)
    await runWith(inputExamples[1]!, scriptedShell([out("bbb222\n"), out(""), ...committingReplies("src/limiter.ts\nsrc/limiter.test.ts\n").slice(2)]).service, agent.service)

    const request = agent.requests[0]!
    expect(request.prompt).toContain("1. reset(key) leaves another key's count unchanged")
    expect(request.prompt).toContain("bug it catches: reset clears the whole map")
    expect(request.prompt).toContain("leave every assertion red")
    expect(request.prompt.endsWith(`\n\n${inputExamples[1]!.addendum!}`)).toBe(true)
    expect(request.prompt).not.toMatch(/verification suite|bun run (typecheck|test)|red suite/i)
    expect(request.agent).toBe("effect-expert")
    expect(request.model).toBe("sonnet")
    expect(request.cwd).toBe("/repo")
  })

  test("a changed path the session did not declare is WriteRedPathsUndeclared, naming it", async () => {
    const shell = scriptedShell(committingReplies("src/limiter.ts\nsrc/limiter.test.ts\nsrc/extra.ts\n"))
    const result = await runWith(inputExamples[0]!, shell.service, declaringAgent(DECLARED).service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new WriteRedPathsUndeclared({ paths: ["src/extra.ts"], sessions: ["red-session"] }))
  })

  test("a declared path the commit does not contain is WriteRedPathsMissing, naming it", async () => {
    const shell = scriptedShell(committingReplies("src/limiter.test.ts\n"))
    const result = await runWith(inputExamples[0]!, shell.service, declaringAgent(DECLARED).service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new WriteRedPathsMissing({ paths: ["src/limiter.ts"], sessions: ["red-session"] }))
  })

  test("a session declaring no test file is WriteRedNoTests, and nothing is committed", async () => {
    const shell = scriptedShell([out("aaa111\n"), out("")])
    const result = await runWith(inputExamples[0]!, shell.service, declaringAgent({ testPaths: [], stubPaths: ["src/limiter.ts"] }).service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(WriteRedNoTests)
    expect(shell.calls).toHaveLength(2)
  })

  test("a moved head is WriteRedHeadMoved before any dispatch", async () => {
    const agent = declaringAgent(DECLARED)
    const result = await runWith(inputExamples[0]!, scriptedShell([out("zzz999\n")]).service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new WriteRedHeadMoved({ expected: "aaa111", observed: "zzz999" }))
    expect(agent.requests).toHaveLength(0)
  })

  test("a dirty tree is WriteRedWorkdirDirty before any dispatch", async () => {
    const agent = declaringAgent(DECLARED)
    const result = await runWith(inputExamples[0]!, scriptedShell([out("aaa111\n"), out(" M other.ts\n")]).service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new WriteRedWorkdirDirty({ paths: ["other.ts"] }))
    expect(agent.requests).toHaveLength(0)
  })
})
