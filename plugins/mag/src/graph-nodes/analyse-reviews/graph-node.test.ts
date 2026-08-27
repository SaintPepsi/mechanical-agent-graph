import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { AnalysisIncomplete, AnalysisRunRootMissing, WindowUnreadable } from "mag/graph-nodes/analyse-reviews/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/analyse-reviews/examples"
import { analyseReviews } from "mag/graph-nodes/analyse-reviews/graph-node"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

const graph = "develop-graph"

const WINDOW = {
  schema: "graph/review-window@1",
  size: 2,
  since: "2026-08-20T00:00:00.000Z",
  through: "2026-08-20T21:16:11.402Z",
  transcriptsRoot: "/home/dev/.claude/projects",
  passes: [
    {
      id: "GH-197/run-1#1",
      projectKey: "proj",
      ticket: "GH-197",
      graph,
      runId: "run-1",
      runRoot: "/home/dev/.claude/graph/proj/GH-197/run-1",
      pass: 1,
      verdict: "clean",
      headSha: "sha1",
      startedAt: "2026-08-20T20:00:00.000Z",
      endedAt: "2026-08-20T20:05:00.000Z",
      findingsPath: "/home/dev/.claude/graph/proj/GH-197/run-1/review-diff-1.md",
      buildSummaryPath: null,
      designPath: null,
      disputePath: null,
      sessions: ["s1"]
    },
    {
      id: "GH-197/run-2#1",
      projectKey: "proj",
      ticket: "GH-197",
      graph,
      runId: "run-2",
      runRoot: "/home/dev/.claude/graph/proj/GH-197/run-2",
      pass: 1,
      verdict: "blocked",
      tag: "REVIEW_BLOCKED",
      headSha: "sha2",
      startedAt: "2026-08-20T21:00:00.000Z",
      endedAt: "2026-08-20T21:16:11.402Z",
      findingsPath: "/home/dev/.claude/graph/proj/GH-197/run-2/review-diff-1.md",
      buildSummaryPath: "/home/dev/.claude/graph/proj/GH-197/run-2/build-1.md",
      designPath: null,
      disputePath: null,
      sessions: []
    }
  ]
}

const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: {
          sendBacks: [{ id: "GH-197/run-2#1", attribution: "build-loose", evidence: "cited", fix: "tighten it" }],
          patterns: [],
          note: ""
        } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.42,
        attempts: 1,
        ...reply
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const base = mkdtempSync(join(tmpdir(), "analyse-reviews-"))
  const runRoot = join(base, "run")
  mkdirSync(runRoot, { recursive: true })
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(base)
  }
}

const writeManifest = (runRoot: string, window: unknown): string => {
  const path = join(runRoot, "window.json")
  writeFileSync(path, JSON.stringify(window))
  return path
}

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, runRoot: string) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, testRunInfo({ runRoot }))
      )
    )
  )

describe("analyse-reviews", () => {
  test("the fixtures decode against analyse-reviews' own schemas", () => {
    if (!isSchemaHandle(analyseReviews.input)) throw new Error("analyseReviews.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(analyseReviews.input)(example)
    if (!isSchemaHandle(analyseReviews.success)) throw new Error("analyseReviews.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(analyseReviews.success)(example)
  })

  test("an empty runRoot is a wiring bug, fails before the manifest is even read", async () => {
    const agent = stubAgent()
    const result = await runWith(
      analyseReviews.run({ manifestPath: "/does/not/matter" }),
      agent.service,
      ""
    )
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(AnalysisRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  test("a manifest that does not exist is WINDOW_UNREADABLE, not a defect", () =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent()
      const result = await runWith(
        analyseReviews.run({ manifestPath: join(runRoot, "missing.json") }),
        agent.service,
        runRoot
      )
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(WindowUnreadable)
      expect(agent.requests).toHaveLength(0)
    }))

  test("a manifest that doesn't decode against the window schema is WINDOW_UNREADABLE", () =>
    withRunRoot(async (runRoot) => {
      const path = writeManifest(runRoot, { not: "a window" })
      const agent = stubAgent()
      const result = await runWith(analyseReviews.run({ manifestPath: path }), agent.service, runRoot)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(WindowUnreadable)
    }))

  test("a reply missing a blocked pass's id is ANALYSIS_INCOMPLETE, and nothing is written", () =>
    withRunRoot(async (runRoot) => {
      const path = writeManifest(runRoot, WINDOW)
      const agent = stubAgent({ verdict: { sendBacks: [], patterns: [], note: "" } })
      const result = await runWith(analyseReviews.run({ manifestPath: path }), agent.service, runRoot)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(AnalysisIncomplete)
      expect((result.failure as AnalysisIncomplete).missing).toStrictEqual(["GH-197/run-2#1"])
    }))

  test("every send-back attributed renders the report and returns its path", () =>
    withRunRoot(async (runRoot) => {
      const path = writeManifest(runRoot, WINDOW)
      const agent = stubAgent()
      const result = await runWith(analyseReviews.run({ manifestPath: path }), agent.service, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        reportPath: join(runRoot, "review-patterns-1.md"),
        sendBacks: 1,
        sessions: ["stub-session"],
        costUsd: 0.42
      })

      const report = readFileSync(join(runRoot, "review-patterns-1.md"), "utf8")
      expect(report.split("\n")[0]).toBe(`Analysed through ${WINDOW.through}`)
      expect(report).toContain("GH-197/run-2#1: build-loose")

      expect(agent.requests[0]!.prompt).toContain(path)
      expect(agent.requests[0]!.prompt).toContain(WINDOW.transcriptsRoot)
    }))

  test("the input's agent and model reach the dispatch verbatim", () =>
    withRunRoot(async (runRoot) => {
      const path = writeManifest(runRoot, WINDOW)
      const agent = stubAgent()
      await runWith(analyseReviews.run({ manifestPath: path, agent: "effect-expert", model: "opus" }), agent.service, runRoot)
      expect(agent.requests[0]!.agent).toBe("effect-expert")
      expect(agent.requests[0]!.model).toBe("opus")
    }))
})
