import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/adversarial-review/examples"
import { VerifyEscapesSuiteRed } from "mag/graph-nodes/adversarial-review/errors"
import { adversarialReview } from "mag/graph-nodes/adversarial-review/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

/**
 * A real tree and the real shell, `verify-escapes/graph-node.test.ts`'s reasoning: the composite's
 * whole point is that a claim only survives by being run, so the tree the claims are run against
 * is real. Only the model sessions are stubbed.
 */
const ORIGINAL = "answer=42\nkey=present\n"
const SUITE = "grep -q '^answer=' src.txt"

const SURVIVOR = { path: "src.txt", find: "42", replace: "43", probeSource: "cat src.txt", rationale: "changes the answer" }
const REFUTED = { ...SURVIVOR, find: "answer=", replace: "broken=", rationale: "breaks the key" }

const isBreakPrompt = (request: ClaudePrint<unknown>) => request.prompt.startsWith("Break the code in")
const isJudgePrompt = (request: ClaudePrint<unknown>) => request.prompt.startsWith("Rate the")

/** Every breaker answers the same claims; the judge rates every index with one category. */
const reviewAgent = (claims: readonly unknown[], category = "quota") => {
  const requests: Array<ClaudePrint<unknown>> = []
  let breaks = 0
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      if (isBreakPrompt(request as ClaudePrint<unknown>)) {
        breaks += 1
        return Effect.succeed({ verdict: { claims } as A, result: {}, sessions: [`break-${breaks}`], costUsd: 0.4, attempts: 1 } as ClaudeReply<A>)
      }
      const count = Number(/Rate the (\d+)/.exec(request.prompt)?.[1] ?? "0")
      const ratings = Array.from({ length: count }, (_, index) => ({ index, category }))
      return Effect.succeed({ verdict: { ratings } as A, result: {}, sessions: ["judge-1"], costUsd: 0.02, attempts: 1 } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const withTree = async <T>(fn: (workRoot: string, runRoot: string) => Promise<T>): Promise<T> => {
  const workRoot = mkdtempSync(join(tmpdir(), "adversarial-review-work-"))
  const runRoot = mkdtempSync(join(tmpdir(), "adversarial-review-run-"))
  try {
    writeFileSync(join(workRoot, "src.txt"), ORIGINAL)
    writeFileSync(join(workRoot, "src.test.ts"), "import { test } from \"bun:test\"\ntest(\"asserts nothing\", () => {\n  read()\n})\n")
    return await fn(workRoot, runRoot)
  } finally {
    await removeDir(workRoot)
    await removeDir(runRoot)
  }
}

const review = (
  input: Partial<Parameters<typeof adversarialReview.run>[0]>,
  agent: ClaudeAgentService,
  workRoot: string,
  runRoot: string
) =>
  Effect.runPromise(
    Effect.result(
      adversarialReview.run({ srcPaths: ["src.txt"], testPaths: ["src.test.ts"], command: SUITE, breakers: 2, budget: 3, ...input }).pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, testRunInfo({ workRoot, runRoot }))
      )
    )
  )

describe("adversarial-review", () => {
  test("the fixtures decode against adversarial-review's own schemas", () => {
    if (!isSchemaHandle(adversarialReview.input)) throw new Error("adversarialReview.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(adversarialReview.input)(example)
    if (!isSchemaHandle(adversarialReview.success)) throw new Error("adversarialReview.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(adversarialReview.success)(example)
  })

  test("sweeps the JS test, dispatches every breaker, verifies each claim for real, rates only the survivors", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = reviewAgent([SURVIVOR, REFUTED])
      const result = await review({}, agent.service, workRoot, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      // Two breakers, two claims each: four claims tried, the survivor kept twice (one per breaker), rated quota = 2.
      expect(result.success.claims).toBe(4)
      expect(result.success.rated).toStrictEqual([
        { path: "src.txt", find: "42", replace: "43", probeSource: "cat src.txt", category: "quota", severity: 2 },
        { path: "src.txt", find: "42", replace: "43", probeSource: "cat src.txt", category: "quota", severity: 2 }
      ])
      expect(result.success.smells.map((finding) => [finding.rule, finding.path])).toStrictEqual([["no-assertion", "src.test.ts"]])
      expect(result.success.sessions).toStrictEqual(["break-1", "break-2", "judge-1"])
      expect(result.success.costUsd).toBeCloseTo(0.82)
      expect(agent.requests.filter(isBreakPrompt)).toHaveLength(2)
      expect(agent.requests.filter(isJudgePrompt)).toHaveLength(1)
    }))

  test("no surviving claim means no judge dispatch, and a non-JS test path skips the sweep without a session", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = reviewAgent([REFUTED])
      const result = await review({ testPaths: ["tests/test_src.py"], breakers: 1 }, agent.service, workRoot, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ rated: [], smells: [], claims: 1, sessions: ["break-1"], costUsd: 0.4 })
      expect(agent.requests.filter(isJudgePrompt)).toHaveLength(0)
    }))

  test("models route to their own dispatch, the agent to both", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = reviewAgent([SURVIVOR])
      await review({ breakers: 1, agent: "effect-expert", breakModel: "sonnet", judgeModel: "haiku" }, agent.service, workRoot, runRoot)

      expect(agent.requests.find(isBreakPrompt)!.model).toBe("sonnet")
      expect(agent.requests.find(isJudgePrompt)!.model).toBe("haiku")
      for (const request of agent.requests) expect(request.agent).toBe("effect-expert")
    }))

  test("a suite red before any claim is verify-escapes's own failure, propagated whole after the breakers spent", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = reviewAgent([SURVIVOR])
      const result = await review({ command: "grep -q '^absent=' src.txt", breakers: 1 }, agent.service, workRoot, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VerifyEscapesSuiteRed)
    }))
})
