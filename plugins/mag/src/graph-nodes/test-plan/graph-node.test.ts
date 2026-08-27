import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { TestPlanAcsEmpty } from "mag/graph-nodes/test-plan/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/test-plan/examples"
import { testPlan } from "mag/graph-nodes/test-plan/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { testRunInfo } from "mag/test/node-fixture"

const PLAN = successExamples[0]!.plan

/** A planner answering a fixed plan and recording what it was asked. */
const planningAgent = (plan: readonly unknown[] = PLAN) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const reply = { result: {}, sessions: ["stub-session"], costUsd: 0.3, attempts: 1 }
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({ verdict: { plan } as A, ...reply } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const runWith = (input: Parameters<typeof testPlan.run>[0], agent: ClaudeAgentService) =>
  Effect.runPromise(
    Effect.result(testPlan.run(input).pipe(Effect.provide(claudeAgentLayer(agent)), Effect.provideService(RunInfo, testRunInfo())))
  )

describe("test-plan", () => {
  test("the fixtures decode against test-plan's own schemas", () => {
    if (!isSchemaHandle(testPlan.input)) throw new Error("testPlan.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(testPlan.input)(example)
    if (!isSchemaHandle(testPlan.success)) throw new Error("testPlan.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(testPlan.success)(example)
  })

  test("the prompt lists every criterion, names the recon note, and asks for the negative space; the session runs in workRoot", async () => {
    const agent = planningAgent()
    const result = await runWith(inputExamples[0]!, agent.service)

    expect(Result.isSuccess(result)).toBe(true)
    const request = agent.requests[0]!
    expect(request.cwd).toBe("/repo")
    expect(request.prompt).toContain("- **AC.01 - reset(key) clears only that key**")
    expect(request.prompt).toContain("- **AC.02 - a repeated reset is safe**")
    expect(request.prompt).toContain("Read docs/graph/GH-98/discover.md")
    expect(request.prompt).toContain("`negativeSpace`")
    expect(request.prompt).toContain("`bugItCatches`")
    expect(request.agent).toBeUndefined()
    expect(request.model).toBeUndefined()
  })

  test("agent and model reach the dispatch verbatim", async () => {
    const agent = planningAgent()
    await runWith(inputExamples[1]!, agent.service)
    expect(agent.requests[0]!.agent).toBe("effect-expert")
    expect(agent.requests[0]!.model).toBe("opus")
  })

  test("the verdict schema refuses an empty plan and an entry with no bug named, so neither can reach the success", async () => {
    const agent = planningAgent()
    await runWith(inputExamples[0]!, agent.service)
    const { decode } = agent.requests[0]!.jsonSchema!

    expect(Result.isFailure(await Effect.runPromise(Effect.result(decode({ plan: [] }))))).toBe(true)
    expect(
      Result.isFailure(await Effect.runPromise(Effect.result(decode({ plan: [{ ...PLAN[0]!, bugItCatches: "" }] }))))
    ).toBe(true)
    expect(Result.isSuccess(await Effect.runPromise(Effect.result(decode({ plan: PLAN }))))).toBe(true)
  })

  test("the plan reaches the success verbatim with the session's spend", async () => {
    const result = await runWith(inputExamples[0]!, planningAgent().service)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ plan: PLAN, sessions: ["stub-session"], costUsd: 0.3 })
  })

  test("no criteria is TestPlanAcsEmpty before any dispatch", async () => {
    const agent = planningAgent()
    const result = await runWith({ acs: [], discoverPath: "docs/graph/GH-98/discover.md" }, agent.service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TestPlanAcsEmpty)
    expect(agent.requests).toHaveLength(0)
  })
})
