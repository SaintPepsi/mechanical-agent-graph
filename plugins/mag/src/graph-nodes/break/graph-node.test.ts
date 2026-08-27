import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { BreakNoSources } from "mag/graph-nodes/break/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/break/examples"
import { breakSuite } from "mag/graph-nodes/break/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { testRunInfo } from "mag/test/node-fixture"

const CLAIM = successExamples[1]!.claims[0]!

/** A breaker that answers a fixed claim list and records what it was asked; the reply shape is `build/graph-node.test.ts`'s stub. */
const claimsAgent = (claims: readonly unknown[] = [CLAIM]) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const reply = { result: {}, sessions: ["stub-session"], costUsd: 0.4, attempts: 1 }
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({ verdict: { claims } as A, ...reply } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const runWith = (input: Parameters<typeof breakSuite.run>[0], agent: ClaudeAgentService) =>
  Effect.runPromise(
    Effect.result(breakSuite.run(input).pipe(Effect.provide(claudeAgentLayer(agent)), Effect.provideService(RunInfo, testRunInfo())))
  )

describe("break", () => {
  test("the fixtures decode against break's own schemas", () => {
    if (!isSchemaHandle(breakSuite.input)) throw new Error("breakSuite.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(breakSuite.input)(example)
    if (!isSchemaHandle(breakSuite.success)) throw new Error("breakSuite.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(breakSuite.success)(example)
  })

  test("the prompt names every source and test path, the budget, and the probe contract; the session runs in workRoot", async () => {
    const agent = claimsAgent()
    const result = await runWith(inputExamples[1]!, agent.service)

    expect(Result.isSuccess(result)).toBe(true)
    expect(agent.requests).toHaveLength(1)
    const request = agent.requests[0]!
    expect(request.cwd).toBe("/repo")
    expect(request.prompt).toContain("src/limiter.ts, src/sync.ts")
    expect(request.prompt).toContain("src/limiter.test.ts")
    expect(request.prompt).toContain("at most 5 claims")
    expect(request.prompt).toContain("POSIX sh script run from the repository root")
    expect(request.prompt).toContain("change nothing on disk")
    expect(request.agent).toBe("effect-expert")
    expect(request.model).toBe("sonnet")
  })

  test("the verdict schema carries the budget as maxItems, so an overrun fails at the transport rather than being trimmed here", async () => {
    const agent = claimsAgent()
    await runWith({ ...inputExamples[0]!, budget: 2 }, agent.service)

    // Effect renders an array check as an `allOf` member on the array, probed against the real serializer.
    const serialized = JSON.parse(agent.requests[0]!.jsonSchema!.serialized) as {
      properties: { claims: { allOf: ReadonlyArray<{ maxItems: number }> } }
    }
    expect(serialized.properties.claims.allOf).toStrictEqual([{ maxItems: 2 }])
    const decoded = await Effect.runPromise(Effect.result(agent.requests[0]!.jsonSchema!.decode({ claims: [CLAIM, CLAIM, CLAIM] })))
    expect(Result.isFailure(decoded)).toBe(true)
  })

  test("the claims reach the success verbatim with the session's spend", async () => {
    const result = await runWith(inputExamples[0]!, claimsAgent().service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ claims: [CLAIM], sessions: ["stub-session"], costUsd: 0.4 })
  })

  test("no source paths is BreakNoSources before any dispatch", async () => {
    const agent = claimsAgent()
    const result = await runWith({ srcPaths: [], testPaths: ["a.test.ts"], budget: 3 }, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BreakNoSources)
    expect(agent.requests).toHaveLength(0)
  })
})
