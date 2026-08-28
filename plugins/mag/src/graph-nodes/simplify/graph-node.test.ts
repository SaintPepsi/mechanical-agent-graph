import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/simplify/examples"
import {
  SimplifyGitFailed,
  SimplifyHeadMoved,
  SimplifyRunRootMissing,
  SimplifyWorkdirDirty
} from "mag/graph-nodes/simplify/errors"
import { simplify } from "mag/graph-nodes/simplify/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { compileSubtraction, SIMPLIFY_PARAMS } from "mag/skills/subtraction"
import { testRunInfo } from "mag/test/node-fixture"

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

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })
/** `git diff --cached --quiet`: exit 0 means nothing staged, exit 1 means the index differs from HEAD. */
const diffCached = (hasStaged: boolean): ShellResult => ({ exitCode: hasStaged ? 1 : 0, stdout: "", stderr: "" })

/** A stub agent that records the request and answers with a canned reply, `build/graph-node.test.ts`'s idiom. */
const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: {} as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.12,
        attempts: 1,
        ...reply
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const INPUT = inputExamples[0]!
const RUN = testRunInfo()

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, shell: ShellService, agent: ClaudeAgentService, run = RUN) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(shellLayer(shell)),
        Effect.provide(claudeAgentLayer(agent)),
        Effect.provideService(RunInfo, run)
      )
    )
  )

describe("simplify", () => {
  test("the fixtures decode against the node's own schemas", () => {
    if (!isSchemaHandle(simplify.input)) throw new Error("input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(simplify.input)(example)
    if (!isSchemaHandle(simplify.success)) throw new Error("success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(simplify.success)(example)
  })

  test("wears the GraphNode shape, so the registry can run it with no graph runner", () => {
    expect(isSchemaHandle(simplify.input)).toBe(true)
    expect(isSchemaHandle(simplify.success)).toBe(true)
    expect(simplify.name).toBe("simplify")
  })

  // A stub agent plus a stub Shell reporting a dirty tree afterward — the node issues
  // `git add -A` and `git commit`, returns the new sha, and reports `simplified: true`.
  test("a dirty tree after the session is staged and committed by the node, and simplified is true", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`), // guardHead
      out("x.ts\n"), // changedPaths
      out(""), // guardCleanTree: clean before dispatch
      out("?? new.ts\n"), // commitAgentLeftovers: dirty after the session
      out(""), // git add -A
      diffCached(true), // git diff --cached --quiet
      out(""), // git commit
      out("bbb222\n") // final rev-parse HEAD
    ])
    const agent = stubAgent()
    const result = await runWith(simplify.run(INPUT), service, agent.service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({
      simplified: true,
      headSha: "bbb222",
      sessions: ["stub-session"],
      costUsd: 0.12,
      sessionRef: "stub-session"
    })
    expect(calls).toHaveLength(8)
    expect(calls[4]).toStrictEqual(["git", "add", "-A"])
    expect(calls[6]![0]).toBe("git")
    expect(calls[6]![1]).toBe("commit")
  })

  // The no-op case: a clean tree after the session — success, simplified: false, the sha unchanged,
  // and no commit argv issued at all (asserting the absence is the claim, not just a green success).
  test("a clean tree after the session is simplified: false, sha unchanged, and no commit argv issued", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`), // guardHead
      out("x.ts\n"), // changedPaths
      out(""), // guardCleanTree
      out(""), // commitAgentLeftovers: clean after the session too
      out(`${INPUT.headSha}\n`) // final rev-parse HEAD: unchanged
    ])
    const agent = stubAgent()
    const result = await runWith(simplify.run(INPUT), service, agent.service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    // A session did run here (`changedPaths` was non-empty), just to no net effect, `sessionRef`
    // rides the result regardless, since a caller may still want to repair this exact head later.
    expect(result.success).toStrictEqual({
      simplified: false,
      headSha: INPUT.headSha,
      sessions: ["stub-session"],
      costUsd: 0.12,
      sessionRef: "stub-session"
    })
    expect(calls).toHaveLength(5)
    for (const call of calls) {
      expect(call).not.toContain("add")
      expect(call).not.toContain("commit")
    }
  })

  // The commit's identity: the subject names the run's own ticket, one Claude-Session trailer per
  // session in the reply.
  test("the commit subject names the ticket, and carries one Claude-Session trailer per session", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("x.ts\n"),
      out(""),
      out("?? new.ts\n"),
      out(""),
      diffCached(true),
      out(""),
      out("bbb222\n")
    ])
    const agent = stubAgent({ sessions: ["s1", "s2"] })
    const result = await runWith(simplify.run(INPUT), service, agent.service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.sessions).toStrictEqual(["s1", "s2"])
    const message = calls[6]!.at(-1)!
    expect(message.startsWith(`refactor(${INPUT.ticket}): simplify`)).toBe(true)
    expect(message).toContain("Claude-Session: s1")
    expect(message).toContain("Claude-Session: s2")
  })

  // The head gate: an observed sha that differs fails SimplifyHeadMoved, no spend at all.
  test("the head gate: a moved HEAD fails SimplifyHeadMoved before any dispatch", async () => {
    const { calls, service } = scriptedShell([out("moved-sha\n")])
    const agent = stubAgent()
    const result = await runWith(simplify.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(SimplifyHeadMoved)
    const failure = result.failure as SimplifyHeadMoved
    expect(failure.expected).toBe(INPUT.headSha)
    expect(failure.observed).toBe("moved-sha")
    expect(agent.requests).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  // The dirty gate: a tree already dirty before dispatch fails SimplifyWorkdirDirty, no dispatch.
  test("the dirty gate: a tree already dirty before dispatch fails SimplifyWorkdirDirty, no dispatch", async () => {
    const { calls, service } = scriptedShell([out(`${INPUT.headSha}\n`), out("x.ts\n"), out("?? scratch.md\n")])
    const agent = stubAgent()
    const result = await runWith(simplify.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(SimplifyWorkdirDirty)
    expect((result.failure as SimplifyWorkdirDirty).paths).toStrictEqual(["scratch.md"])
    expect(agent.requests).toHaveLength(0)
    expect(calls).toHaveLength(3)
  })

  // The short-circuit: an empty `--name-only` answer skips the dispatch entirely; costUsd is 0, not
  // null — no session ran, so the figure is zero rather than unpriced.
  test("the short-circuit: an empty range skips the dispatch, costUsd is 0", async () => {
    const { calls, service } = scriptedShell([out(`${INPUT.headSha}\n`), out("")])
    const agent = stubAgent()
    const result = await runWith(simplify.run(INPUT), service, agent.service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ simplified: false, headSha: INPUT.headSha, sessions: [], costUsd: 0 })
    expect(agent.requests).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })

  // A failing git read (the head gate's own rev-parse) is SimplifyGitFailed, not silently absorbed.
  test("a failing head-gate git read is SimplifyGitFailed, and the agent is never spawned", async () => {
    const { service } = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }])
    const agent = stubAgent()
    const result = await runWith(simplify.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(SimplifyGitFailed)
    expect(agent.requests).toHaveLength(0)
  })

  // The standard reaches the session: a prompt sniff, keyed on the standard's own wording.
  test("the standard reaches the dispatched prompt", async () => {
    const { service } = scriptedShell([
      out(`${INPUT.headSha}\n`), // guardHead
      out("x.ts\n"), // changedPaths
      out(""), // guardCleanTree
      out(""), // commitAgentLeftovers: clean after the session too
      out(`${INPUT.headSha}\n`) // final rev-parse HEAD: unchanged
    ])
    const agent = stubAgent()
    await runWith(simplify.run(INPUT), service, agent.service)

    expect(agent.requests).toHaveLength(1)
    const prompt = agent.requests[0]!.prompt
    expect(prompt).toContain(compileSubtraction(SIMPLIFY_PARAMS))
    expect(prompt).toContain("Reduce this diff to the same behaviour in less code")
  })

  test("an empty runRoot is a wiring bug, not a data problem — fails before any dispatch", async () => {
    const agent = stubAgent()
    const result = await runWith(simplify.run(INPUT), scriptedShell([]).service, agent.service, testRunInfo({ runRoot: "" }))

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(SimplifyRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })
})
