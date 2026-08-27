import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { DerivationEmpty, DerivationRunRootMissing, DerivedCopyFailed } from "mag/graph-nodes/derive-vision/errors"
import { deriveVision, DRAWING_FILENAME } from "mag/graph-nodes/derive-vision/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/derive-vision/examples"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

/**
 * `write` stands in for the session's own filesystem side effect (`envision-mermaid/graph-node.test.ts`'s
 * idiom), fired inside `prompt` so it lands between the node's before-dispatch snapshot and its
 * after-dispatch read.
 */
const stubAgent = (write?: () => void) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      write?.()
      return Effect.succeed({
        verdict: { derivedVisionPath: "ignored — the node uses its own computed path" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.12,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** A fixture tree with both roots a real run needs: `codeRoot` (the session's own cwd, where the
 * drawing lands first) and `runRoot` (where `writeArtifact` copies it after, `graph-node.ts`'s two-step). */
const withRoots = async (
  fn: (paths: { readonly codeRoot: string; readonly graphRoot: string; readonly runRoot: string }) => Promise<void>
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "derive-vision-"))
  try {
    const codeRoot = join(root, "code-only")
    const graphRoot = join(codeRoot, "graphs", "design-graph")
    const runRoot = join(root, "run")
    mkdirSync(graphRoot, { recursive: true })
    mkdirSync(runRoot, { recursive: true })
    await fn({ codeRoot, graphRoot, runRoot })
  } finally {
    await removeDir(root)
  }
}

const runNode = (paths: { readonly codeRoot: string; readonly graphRoot: string }, runRoot: string, agent: ClaudeAgentService) =>
  Effect.runPromise(
    Effect.result(
      deriveVision.run({ codeRoot: paths.codeRoot, graphRoot: paths.graphRoot }).pipe(
        Effect.provide(claudeAgentLayer(agent)),
        Effect.provideService(RunInfo, testRunInfo({ runRoot }))
      )
    )
  )

describe("deriveVision", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(deriveVision.input)) throw new Error("deriveVision.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(deriveVision.input)(example)
    if (!isSchemaHandle(deriveVision.success)) throw new Error("deriveVision.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(deriveVision.success)(example)
  })

  test("the session's cwd and its drawing's destination are both inside codeRoot, never the run root", () =>
    withRoots(async ({ codeRoot, graphRoot, runRoot }) => {
      const agent = stubAgent()
      await runNode({ codeRoot, graphRoot }, runRoot, agent.service)
      expect(agent.requests[0]!.cwd).toBe(codeRoot)
      expect(agent.requests[0]!.prompt).toContain(`${codeRoot}/${DRAWING_FILENAME}`)
    }))

  test("the prompt names graphRoot, never the shipped vision's filename", () =>
    withRoots(async ({ codeRoot, graphRoot, runRoot }) => {
      const agent = stubAgent()
      await runNode({ codeRoot, graphRoot }, runRoot, agent.service)

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(graphRoot)
      // The shipped filename bare (`/vision.md`), not the derived one's own `derived-vision.md` destination.
      expect(prompt).not.toContain("/vision.md`")
    }))

  test("a written drawing is copied into the run root as a numbered artifact, independent of the staging tree", () =>
    withRoots(async ({ codeRoot, graphRoot, runRoot }) => {
      const agent = stubAgent(() => writeFileSync(`${codeRoot}/${DRAWING_FILENAME}`, "graph TD\n  A --> B\n"))
      const result = await runNode({ codeRoot, graphRoot }, runRoot, agent.service)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        derivedVisionPath: `${runRoot}/derived-vision-1.md`,
        sessions: ["stub-session"],
        costUsd: 0.12
      })
      expect(readFileSync(`${runRoot}/derived-vision-1.md`, "utf8")).toBe("graph TD\n  A --> B\n")
      // A copy, not a move: the staging tree still carries the session's own drawing too.
      expect(existsSync(`${codeRoot}/${DRAWING_FILENAME}`)).toBe(true)
    }))

  test("a session that never wrote the drawing is DerivationEmpty, carrying the destination and sessions spent", () =>
    withRoots(async ({ codeRoot, graphRoot, runRoot }) => {
      const result = await runNode({ codeRoot, graphRoot }, runRoot, stubAgent().service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DerivationEmpty)
      const failure = result.failure as DerivationEmpty
      expect(failure.destination).toBe(`${codeRoot}/${DRAWING_FILENAME}`)
      expect(failure.sessions).toStrictEqual(["stub-session"])
    }))

  test("a blank drawing is DerivationEmpty too", () =>
    withRoots(async ({ codeRoot, graphRoot, runRoot }) => {
      writeFileSync(`${codeRoot}/${DRAWING_FILENAME}`, "  \n")
      const result = await runNode({ codeRoot, graphRoot }, runRoot, stubAgent().service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DerivationEmpty)
    }))

  test("a run root the artifact copy cannot write to fails DerivedCopyFailed, after a real session already produced the drawing", () =>
    withRoots(async ({ codeRoot, graphRoot, runRoot }) => {
      // `write-pr-body/graph-node.test.ts`'s ENOTDIR trick: a real file sitting where a path
      // component of the run root needs to be a directory.
      const blocker = `${runRoot}-blocker`
      writeFileSync(blocker, "not a directory")
      const brokenRoot = join(blocker, "subdir")

      const agent = stubAgent(() => writeFileSync(`${codeRoot}/${DRAWING_FILENAME}`, "graph TD\n"))
      const result = await runNode({ codeRoot, graphRoot }, brokenRoot, agent.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DerivedCopyFailed)
      const failure = result.failure as DerivedCopyFailed
      expect(failure.runRoot).toBe(brokenRoot)
      expect(failure.sessions).toStrictEqual(["stub-session"])
    }))

  test("an empty runRoot is a wiring bug, not a data problem — DerivationRunRootMissing before any dispatch", async () => {
    const agent = stubAgent()
    const result = await Effect.runPromise(
      Effect.result(
        deriveVision.run({ codeRoot: "/irrelevant/code-only", graphRoot: "/irrelevant/code-only/graphs/x" }).pipe(
          Effect.provide(claudeAgentLayer(agent.service)),
          Effect.provideService(RunInfo, testRunInfo({ runRoot: "" }))
        )
      )
    )

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(DerivationRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })
})
