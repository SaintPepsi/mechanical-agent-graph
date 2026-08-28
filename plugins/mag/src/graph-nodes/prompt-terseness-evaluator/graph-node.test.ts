import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import {
  TersenessCommitFailed,
  TersenessGitFailed,
  TersenessHeadMoved,
  TersenessRunRootMissing,
  TersenessWorkdirDirty
} from "mag/graph-nodes/prompt-terseness-evaluator/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/prompt-terseness-evaluator/examples"
import { promptTersenessEvaluator } from "mag/graph-nodes/prompt-terseness-evaluator/graph-node"
import { UsageLimit } from "mag/runtime/claude/errors"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

/** In-order scripted shell: one reply per `Shell.run` call, in the sequence the node makes them. */
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

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

/** `git diff --cached --quiet`: exit 0 means nothing staged, exit 1 means the index differs from HEAD. */
const diffCached = (hasStaged: boolean): ShellResult => ({ exitCode: hasStaged ? 1 : 0, stdout: "", stderr: "" })

/** A stub agent that records the request and answers with a canned reply. */
const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { rewritten: 1 } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.31,
        attempts: 1,
        ...reply
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const RUN = testRunInfo()
const INPUT = inputExamples[0]!

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, shell: ShellService, agent: ClaudeAgentService, run: RunInfoService = RUN) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

describe("prompt-terseness-evaluator", () => {
  test("the fixtures decode against the node's own schemas", () => {
    if (!isSchemaHandle(promptTersenessEvaluator.input)) throw new Error("input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(promptTersenessEvaluator.input)(example)
    if (!isSchemaHandle(promptTersenessEvaluator.success)) throw new Error("success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(promptTersenessEvaluator.success)(example)
  })

  test("no changed paths is a mechanical success: no dispatch, rewritten 0, headSha unchanged", async () => {
    const { calls, service } = scriptedShell([out(`${INPUT.headSha}\n`), out("")])
    const agent = stubAgent()
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, agent.service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ rewritten: 0, headSha: INPUT.headSha, sessions: [], costUsd: 0 })
    expect(agent.requests).toHaveLength(0)
    expect(calls.map((call) => call.argv)).toStrictEqual([
      ["git", "rev-parse", "HEAD"],
      ["git", "diff", "--name-only", `${INPUT.base}...HEAD`]
    ])
  })

  test("a headSha that disagrees with the checkout's own HEAD is TersenessHeadMoved, before any other read or dispatch", async () => {
    const observed = "deadbeef00000000000000000000000000000000"
    const { calls, service } = scriptedShell([out(`${observed}\n`)])
    const agent = stubAgent()
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessHeadMoved)
    const moved = result.failure as TersenessHeadMoved
    expect(moved.expected).toBe(INPUT.headSha)
    expect(moved.observed).toBe(observed)
    expect(agent.requests).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  test("changed paths dispatch the agent with the range and the compiled persona, cwd from workRoot", async () => {
    const { service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(""),
      out(""),
      out(`${INPUT.headSha}\n`)
    ])
    const agent = stubAgent()
    await runWith(promptTersenessEvaluator.run(INPUT), service, agent.service, testRunInfo({ workRoot: "/repo" }))

    expect(agent.requests).toHaveLength(1)
    const request = agent.requests[0]!
    expect(request.cwd).toBe("/repo")
    expect(request.prompt).toContain(`git diff ${INPUT.base}...HEAD`)
    expect(request.prompt).toContain("Rewrite every verbose prompt in this diff as a terse one-liner.")
    expect(request.prompt).toContain("one instruction, one line")
    expect(request.prompt.startsWith("Diff range")).toBe(true)
  })

  test("the input's agent and model reach the dispatch verbatim; without them, none is sent", async () => {
    const bare = stubAgent()
    await runWith(
      promptTersenessEvaluator.run(INPUT),
      scriptedShell([out(`${INPUT.headSha}\n`), out("src/prompt.ts\n"), out(""), out(""), out(`${INPUT.headSha}\n`)]).service,
      bare.service
    )
    expect(bare.requests[0]!.agent).toBeUndefined()
    expect(bare.requests[0]!.model).toBeUndefined()

    const hardwired = stubAgent()
    const withAgent = inputExamples[1]!
    await runWith(
      promptTersenessEvaluator.run(withAgent),
      scriptedShell([
        out(`${withAgent.headSha}\n`),
        out("src/prompt.ts\n"),
        out(""),
        out(""),
        out(`${withAgent.headSha}\n`)
      ]).service,
      hardwired.service
    )
    expect(hardwired.requests[0]!.agent).toBe("effect-expert")
    expect(hardwired.requests[0]!.model).toBe("opus")
  })

  test("a clean tree after dispatch draws no commit of the node's own — headSha unchanged", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(""),
      out(""),
      out(`${INPUT.headSha}\n`)
    ])
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, stubAgent().service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({
      rewritten: 1,
      headSha: INPUT.headSha,
      sessions: ["stub-session"],
      costUsd: 0.31
    })
    for (const call of calls) {
      expect(call.argv).not.toContain("add")
      expect(call.argv).not.toContain("commit")
    }
  })

  test("a dirty tree after dispatch is staged and committed by the node, headSha measured after the commit", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(""),
      out("?? src/prompt.ts\n"),
      out(""),
      diffCached(true),
      out(""),
      out("bbb222\n")
    ])
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, stubAgent().service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.headSha).toBe("bbb222")
    expect(calls.map((call) => call.argv)).toStrictEqual([
      ["git", "rev-parse", "HEAD"],
      ["git", "diff", "--name-only", `${INPUT.base}...HEAD`],
      ["git", "status", "--porcelain"],
      ["git", "status", "--porcelain"],
      ["git", "add", "-A"],
      ["git", "diff", "--cached", "--quiet"],
      ["git", "commit", "-m", calls[6]!.argv[3]!],
      ["git", "rev-parse", "HEAD"]
    ])
  })

  test("the commit message names the run's own ticket and one Claude-Session trailer per session", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(""),
      out("?? src/prompt.ts\n"),
      out(""),
      diffCached(true),
      out(""),
      out("bbb222\n")
    ])
    const agent = stubAgent({ sessions: ["s1", "s2"] })
    await runWith(promptTersenessEvaluator.run(INPUT), service, agent.service)

    const message = calls[6]!.argv[3]!
    expect(message).toContain(INPUT.ticket)
    expect(message).toContain("prompt-terseness-evaluator")
    expect(message).toContain("Claude-Session: s1")
    expect(message).toContain("Claude-Session: s2")
  })

  test("a dirty status probe that stages nothing is a no-op, not a failure", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(""),
      out(" M sub\n"),
      out(""),
      diffCached(false),
      out(`${INPUT.headSha}\n`)
    ])
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, stubAgent().service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.headSha).toBe(INPUT.headSha)
    for (const call of calls) expect(call.argv).not.toContain("commit")
  })

  test("a failing head-gate read is TersenessGitFailed — the agent is never spawned", async () => {
    const { service } = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }])
    const agent = stubAgent()
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessGitFailed)
    expect((result.failure as TersenessGitFailed).exitCode).toBe(128)
    expect(agent.requests).toHaveLength(0)
  })

  test("a failing changed-paths read is TersenessGitFailed — the agent is never spawned", async () => {
    const { service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      { exitCode: 128, stdout: "", stderr: "fatal: bad revision\n" }
    ])
    const agent = stubAgent()
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessGitFailed)
    expect(agent.requests).toHaveLength(0)
  })

  test("a failing pre-dispatch status probe is TersenessGitFailed, before any spend", async () => {
    const { service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      { exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }
    ])
    const agent = stubAgent()
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessGitFailed)
    expect((result.failure as TersenessGitFailed).argv).toBe("git status --porcelain")
    expect(agent.requests).toHaveLength(0)
  })

  test("a tree already dirty before dispatch is TersenessWorkdirDirty, before any spend", async () => {
    const { service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(" M unrelated.ts\n")
    ])
    const agent = stubAgent()
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessWorkdirDirty)
    expect((result.failure as TersenessWorkdirDirty).paths).toStrictEqual(["unrelated.ts"])
    expect(agent.requests).toHaveLength(0)
  })

  test("a failing post-dispatch status probe is TersenessGitFailed, distinct from the pre-dispatch probe's own", async () => {
    const { service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(""),
      { exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }
    ])
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, stubAgent().service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessGitFailed)
    expect((result.failure as TersenessGitFailed).argv).toBe("git status --porcelain")
  })

  test("a failing `git add -A` is TersenessCommitFailed, carrying the stderr, stdout and the sessions already spent", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(""),
      out("?? src/prompt.ts\n"),
      { exitCode: 128, stdout: "", stderr: "fatal: unable to write new index file\n" }
    ])
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, stubAgent().service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessCommitFailed)
    const failure = result.failure as TersenessCommitFailed
    expect(failure.argv).toBe("git add -A")
    expect(failure.exitCode).toBe(128)
    expect(failure.stderr).toBe("fatal: unable to write new index file")
    expect(failure.sessions).toStrictEqual(["stub-session"])
    expect(calls).toHaveLength(5)
  })

  test("a failing `git commit` is TersenessCommitFailed, and no further git call is issued", async () => {
    const { calls, service } = scriptedShell([
      out(`${INPUT.headSha}\n`),
      out("src/prompt.ts\n"),
      out(""),
      out("?? src/prompt.ts\n"),
      out(""),
      diffCached(true),
      { exitCode: 1, stdout: "", stderr: "fatal: empty ident name (for <>) not allowed\n" }
    ])
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, stubAgent().service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessCommitFailed)
    const failure = result.failure as TersenessCommitFailed
    expect(failure.argv).toBe("git commit -m <message>")
    expect(failure.stderr).toBe("fatal: empty ident name (for <>) not allowed")
    expect(calls).toHaveLength(7)
  })

  test("an empty runRoot is a wiring bug, not a data problem — fails before any dispatch", async () => {
    const agent = stubAgent()
    const result = await runWith(
      promptTersenessEvaluator.run(INPUT),
      scriptedShell([]).service,
      agent.service,
      testRunInfo({ runRoot: "" })
    )

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TersenessRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  test("a transport failure passes through untouched — the tag reaches the graph, not a wrapper", async () => {
    const { service } = scriptedShell([out(`${INPUT.headSha}\n`), out("src/prompt.ts\n"), out("")])
    const limit = new UsageLimit({ resetAt: "2026-08-18T20:00:00Z", source: "api_retry", sessionId: "s" })
    const failing: ClaudeAgentService = { prompt: () => Effect.fail(limit) }
    const result = await runWith(promptTersenessEvaluator.run(INPUT), service, failing)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe(limit)
  })
})
