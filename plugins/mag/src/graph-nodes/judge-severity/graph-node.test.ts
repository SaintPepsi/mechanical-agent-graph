import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { SeverityRatingsIncomplete, SeverityRunRootMissing } from "mag/graph-nodes/judge-severity/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/judge-severity/examples"
import { judgeSeverity } from "mag/graph-nodes/judge-severity/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

const ESCAPE = inputExamples[0]!.escapes[0]!
const OTHER = { ...ESCAPE, path: "src/sync.ts", find: "await store.put(row)", replace: "store.put(row)" }

const stubAgent = (ratings: readonly unknown[]) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { ratings } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.02,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "judge-severity-"))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

const runWith = (input: Parameters<typeof judgeSeverity.run>[0], agent: ClaudeAgentService, runRoot: string) =>
  Effect.runPromise(
    Effect.result(
      judgeSeverity.run(input).pipe(
        Effect.provide(claudeAgentLayer(agent)),
        Effect.provideService(RunInfo, testRunInfo({ runRoot }))
      )
    )
  )

describe("judge-severity", () => {
  test("the fixtures decode against judge-severity's own schemas", () => {
    if (!isSchemaHandle(judgeSeverity.input)) throw new Error("judgeSeverity.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(judgeSeverity.input)(example)
    if (!isSchemaHandle(judgeSeverity.success)) throw new Error("judgeSeverity.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(judgeSeverity.success)(example)
  })

  test("severity is the table's number for the category the judge picked, never a number the judge said", () =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent([
        { index: 1, category: "durability" },
        { index: 0, category: "boundary" }
      ])
      const result = await runWith({ escapes: [ESCAPE, OTHER], model: "haiku" }, agent.service, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        rated: [
          { ...ESCAPE, category: "boundary", severity: 1 },
          { ...OTHER, category: "durability", severity: 3 }
        ],
        sessions: ["stub-session"],
        costUsd: 0.02
      })
      expect(agent.requests[0]!.model).toBe("haiku")
    }))

  test("the escapes travel as a run-root file the prompt names, with the closed category list in the prompt", () =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent([{ index: 0, category: "quota" }])
      await runWith({ escapes: [ESCAPE] }, agent.service, runRoot)

      const prompt = agent.requests[0]!.prompt
      const escapesPath = join(runRoot, "escapes-1.json")
      expect(prompt).toContain(escapesPath)
      expect(prompt).toContain("data-loss, isolation, durability, quota, boundary, cosmetic")
      expect(JSON.parse(readFileSync(escapesPath, "utf8"))).toStrictEqual([ESCAPE])
      // Blind: nothing the breaker wrote about the escape reaches the judge.
      expect(prompt).not.toContain("rationale")
    }))

  test("a reply that skips or repeats an index is SeverityRatingsIncomplete, naming both", () =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent([
        { index: 0, category: "quota" },
        { index: 0, category: "cosmetic" }
      ])
      const result = await runWith({ escapes: [ESCAPE, OTHER] }, agent.service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(
        new SeverityRatingsIncomplete({ missing: [1], duplicated: [0], sessions: ["stub-session"] })
      )
    }))

  test("no escapes is an empty rating with no dispatch and no run root needed", async () => {
    const agent = stubAgent([])
    const result = await runWith({ escapes: [] }, agent.service, "")

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ rated: [], sessions: [], costUsd: 0 })
    expect(agent.requests).toHaveLength(0)
  })

  test("escapes with no run root is SeverityRunRootMissing before any dispatch", async () => {
    const agent = stubAgent([])
    const result = await runWith({ escapes: [ESCAPE] }, agent.service, "")

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(SeverityRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })
})
