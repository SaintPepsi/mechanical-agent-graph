import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import {
  ImplementHeadMoved,
  ImplementNoCommits,
  ImplementResumeEmpty,
  ImplementRunRootMissing,
  TestDisputed
} from "mag/graph-nodes/implement/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/implement/examples"
import { implement } from "mag/graph-nodes/implement/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

/**
 * The git answers for a session that committed its own work, in the order the node asks: the head
 * gate, the pre-dispatch dirty probe, [the session], the leftover probe (clean), the commit count,
 * the post-pass sha. Drained by `git()` below one call at a time; a call past the end throws.
 */
const selfCommitted = (count: string, head: string) => [out("ccc333\n"), out(""), out(""), out(count), out(head)]

const git = (replies: readonly ShellResult[]) => {
  const remaining = [...replies]
  const calls: string[][] = []
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const reply = remaining.shift()
      if (reply === undefined) throw new Error(`git: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

/** A session answering a fixed summary, optionally with a dispute. */
const implementingAgent = (verdict: { summary: string; dispute?: string }) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({ verdict: verdict as A, result: {}, sessions: ["green-session"], costUsd: 0.5, attempts: 1 } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const inRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "implement-"))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

const runWith = (input: Parameters<typeof implement.run>[0], shell: ShellService, agent: ClaudeAgentService, runRoot: string) =>
  Effect.runPromise(
    Effect.result(
      implement.run(input).pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, testRunInfo({ runRoot }))
      )
    )
  )

describe("implement", () => {
  test("the fixtures decode against implement's own schemas", () => {
    if (!isSchemaHandle(implement.input)) throw new Error("implement.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(implement.input)(example)
    if (!isSchemaHandle(implement.success)) throw new Error("implement.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(implement.success)(example)
  })

  test("a committing pass succeeds with the measured count and sha; the prompt names the tests, the plan, and no suite command", () =>
    inRunRoot(async (runRoot) => {
      const agent = implementingAgent({ summary: "made it pass" })
      const result = await runWith(inputExamples[0]!, git(selfCommitted("1\n", "ddd444\n")).service, agent.service, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ headSha: "ddd444", commits: 1, sessions: ["green-session"], costUsd: 0.5, sessionRef: "green-session" })
      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain("Make the tests in src/limiter.test.ts pass by editing source files only")
      expect(prompt).toContain("1. reset(key) leaves another key's count unchanged")
      expect(prompt).toContain("`dispute`")
      expect(prompt).not.toMatch(/verification suite|bun run (typecheck|test)|red suite/i)
    }))

  test("a resumed pass carries only the addendum and the resume id, the plan already held by the session", () =>
    inRunRoot(async (runRoot) => {
      const agent = implementingAgent({ summary: "fixed" })
      const resumed = inputExamples[1]!
      await runWith(resumed, git([out("ddd444\n"), out(""), out(""), out("1\n"), out("eee555\n")]).service, agent.service, runRoot)

      const request = agent.requests[0]!
      expect(request.resume).toBe("a1b2c3")
      expect(request.prompt).toBe(resumed.addendum!)
      expect(request.agent).toBe("effect-expert")
      expect(request.model).toBe("sonnet")
    }))

  test("a dispute in the reply is TestDisputed with the argument on disk, even when the pass also committed", () =>
    inRunRoot(async (runRoot) => {
      const agent = implementingAgent({ summary: "partial", dispute: "the test expects count(\"b\") to be 1 but AC.02 says a reset clears every key" })
      const result = await runWith(inputExamples[0]!, git(selfCommitted("1\n", "ddd444\n")).service, agent.service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestDisputed)
      const disputed = result.failure as TestDisputed
      expect(disputed.disputePath).toBe(join(runRoot, "test-dispute-1.md"))
      expect(disputed.headSha).toBe("ddd444")
      expect(disputed.commits).toBe(1)
      expect(readFileSync(disputed.disputePath, "utf8")).toBe("the test expects count(\"b\") to be 1 but AC.02 says a reset clears every key")
    }))

  test("a whitespace-only dispute is silence: zero commits with HEAD in place is ImplementNoCommits", () =>
    inRunRoot(async (runRoot) => {
      const agent = implementingAgent({ summary: "nothing", dispute: "  \n" })
      const result = await runWith(inputExamples[0]!, git(selfCommitted("0\n", "ccc333\n")).service, agent.service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new ImplementNoCommits({ sessions: ["green-session"] }))
    }))

  test("zero forward commits with a moved HEAD is ImplementHeadMoved, a lost tree rather than silence", () =>
    inRunRoot(async (runRoot) => {
      const result = await runWith(
        inputExamples[0]!,
        git(selfCommitted("0\n", "zzz999\n")).service,
        implementingAgent({ summary: "reset" }).service,
        runRoot
      )
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new ImplementHeadMoved({ expected: "ccc333", observed: "zzz999" }))
    }))

  test("resume with no addendum is ImplementResumeEmpty, and no run root is ImplementRunRootMissing, both before any read", async () => {
    const agent = implementingAgent({ summary: "unused" })
    const shell = git([])

    const resumeEmpty = await runWith({ ...inputExamples[0]!, resume: "a1b2c3" }, shell.service, agent.service, "/unused")
    expect(Result.isFailure(resumeEmpty)).toBe(true)
    if (Result.isFailure(resumeEmpty)) expect(resumeEmpty.failure).toBeInstanceOf(ImplementResumeEmpty)

    const noRoot = await runWith(inputExamples[0]!, shell.service, agent.service, "")
    expect(Result.isFailure(noRoot)).toBe(true)
    if (Result.isFailure(noRoot)) expect(noRoot.failure).toBeInstanceOf(ImplementRunRootMissing)

    expect(shell.calls).toHaveLength(0)
    expect(agent.requests).toHaveLength(0)
  })
})
