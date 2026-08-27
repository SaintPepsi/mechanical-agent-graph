import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Result, Schema } from "effect"
import { WindowNotFull, WindowRunRootMissing } from "mag/graph-nodes/gather-reviews/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/gather-reviews/examples"
import { gatherReviews } from "mag/graph-nodes/gather-reviews/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { RunRootEnv } from "mag/runtime/run-layers"
import { testJournalStamp, testRunInfo } from "mag/test/node-fixture"

/**
 * Testing strategy: `RunRootEnv` provided with `CLAUDE_CONFIG_DIR` pointed at an `mkdtempSync`
 * directory holding hand-written journals and artifacts, so `gather-reviews` runs against a real
 * graph root with nothing mocked.
 */

/** Deletes a fixture directory, and only a fixture directory: anything outside tmpdir is refused. */
const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

const at = (minute: number): string => `2026-08-20T00:${String(minute).padStart(2, "0")}:00.000Z`

/** One run directory holding a single clean review-diff pass and its findings artifact. */
const writeReviewRun = (
  graphRootDir: string,
  parts: { readonly ticket: string; readonly runId: string; readonly headSha: string; readonly endedAt: string }
): void => {
  const dir = join(graphRootDir, "proj-abc12345", parts.ticket, parts.runId)
  mkdirSync(dir, { recursive: true })
  const stamp = testJournalStamp({ runId: parts.runId, ticket: parts.ticket, sha: "tree" })
  const rows = [
    { schema: "graph/journal@3", ...stamp, node: "review-diff", attempt: 1, event: "start", timestamp: parts.endedAt },
    {
      schema: "graph/journal@3",
      ...stamp,
      node: "review-diff",
      attempt: 1,
      event: "end",
      timestamp: parts.endedAt,
      replayed: false,
      input: { headSha: parts.headSha },
      outcome: "ok",
      success: { findingsPath: "unused", headSha: parts.headSha, sessions: ["s1"], costUsd: 0.1 }
    }
  ]
  writeFileSync(join(dir, "journal.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
  writeFileSync(join(dir, "review-diff-1.md"), `Reviewed at ${parts.headSha}\n\nNo blocking findings.`)
}

const writePriorReport = (graphRootDir: string, ticket: string, runId: string, analysedThrough: string): void => {
  const dir = join(graphRootDir, "proj-abc12345", ticket, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "review-patterns-1.md"), `Analysed through ${analysedThrough}\nWindow: ...\n`)
}

/** `graphRoot(env, home)` resolves to `<CLAUDE_CONFIG_DIR>/graph` (`run-root.ts`) — this is that directory, ready to hold fixture runs. */
const withGraphRoot = async (fn: (graphRootDir: string, configDir: string) => Promise<void>): Promise<void> => {
  const configDir = mkdtempSync(join(tmpdir(), "gather-reviews-"))
  const graphRootDir = join(configDir, "graph")
  mkdirSync(graphRootDir, { recursive: true })
  try {
    await fn(graphRootDir, configDir)
  } finally {
    await removeDir(configDir)
  }
}

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, configDir: string, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provideService(RunRootEnv, { env: { CLAUDE_CONFIG_DIR: configDir }, home: "/unused" }),
        Effect.provideService(RunInfo, run)
      )
    )
  )

describe("gather-reviews", () => {
  test("the fixtures decode against gather-reviews' own schemas", () => {
    if (!isSchemaHandle(gatherReviews.input)) throw new Error("gatherReviews.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(gatherReviews.input)(example)
    if (!isSchemaHandle(gatherReviews.success)) throw new Error("gatherReviews.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(gatherReviews.success)(example)
  })

  test("an empty graph root is WINDOW_NOT_FULL, not a failure to scan", () =>
    withGraphRoot(async (_graphRootDir, configDir) => {
      const runRoot = join(configDir, "graph", "self", "GH-213", "self-run")
      const result = await runWith(
        gatherReviews.run({ size: 5, epoch: "2026-08-01T00:00:00.000Z" }),
        configDir,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(WindowNotFull)
      const failure = result.failure as WindowNotFull
      expect(failure).toMatchObject({ passes: 0, size: 5, since: "2026-08-01T00:00:00.000Z" })
      expect(existsSync(join(runRoot, "window.json"))).toBe(false)
    }))

  test("an empty runRoot is a wiring bug, not a data problem — fails before any scan", () =>
    withGraphRoot(async (_graphRootDir, configDir) => {
      const result = await runWith(
        gatherReviews.run({ size: 5, epoch: "2026-08-01T00:00:00.000Z" }),
        configDir,
        testRunInfo({ runRoot: "" })
      )
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(WindowRunRootMissing)
    }))

  test("a full window materializes window.json, findings paired by sha, not by position", () =>
    withGraphRoot(async (graphRootDir, configDir) => {
      for (let n = 1; n <= 5; n++) {
        writeReviewRun(graphRootDir, { ticket: "GH-197", runId: `run-${n}`, headSha: `sha${n}`, endedAt: at(n) })
      }
      const runRoot = join(configDir, "graph", "self", "GH-213", "self-run")
      const result = await runWith(
        gatherReviews.run({ size: 5, epoch: "2026-08-01T00:00:00.000Z" }),
        configDir,
        testRunInfo({ runRoot })
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        manifestPath: join(runRoot, "window.json"),
        passes: 5,
        runs: 5,
        since: "2026-08-01T00:00:00.000Z",
        through: at(5)
      })

      const manifest = JSON.parse(readFileSync(join(runRoot, "window.json"), "utf8"))
      expect(manifest.schema).toBe("graph/review-window@1")
      expect(manifest.passes).toHaveLength(5)
      for (let n = 1; n <= 5; n++) {
        const pass = manifest.passes.find((p: { runId: string }) => p.runId === `run-${n}`)
        expect(pass.findingsPath).toBe(join(graphRootDir, "proj-abc12345", "GH-197", `run-${n}`, "review-diff-1.md"))
        expect(pass.buildSummaryPath).toBeNull()
        expect(pass.designPath).toBeNull()
      }
    }))

  test("the watermark from a prior report excludes every pass at or before it", () =>
    withGraphRoot(async (graphRootDir, configDir) => {
      for (let n = 1; n <= 6; n++) {
        writeReviewRun(graphRootDir, { ticket: "GH-197", runId: `run-${n}`, headSha: `sha${n}`, endedAt: at(n) })
      }
      const runRoot = join(configDir, "graph", "self", "GH-213", "self-run")

      // Without a watermark, all six are eligible and the oldest five fill the window.
      const full = await runWith(
        gatherReviews.run({ size: 5, epoch: "2026-08-01T00:00:00.000Z" }),
        configDir,
        testRunInfo({ runRoot: join(runRoot, "a") })
      )
      expect(Result.isSuccess(full)).toBe(true)
      if (Result.isSuccess(full)) expect(full.success.through).toBe(at(5))

      // A prior report watermarked past pass 2 leaves only four eligible — short of five.
      writePriorReport(graphRootDir, "GH-213", "prior-run", at(2))
      const short = await runWith(
        gatherReviews.run({ size: 5, epoch: "2026-08-01T00:00:00.000Z" }),
        configDir,
        testRunInfo({ runRoot: join(runRoot, "b") })
      )
      expect(Result.isFailure(short)).toBe(true)
      if (!Result.isFailure(short)) return
      expect(short.failure).toBeInstanceOf(WindowNotFull)
      expect((short.failure as WindowNotFull).passes).toBe(4)
      expect((short.failure as WindowNotFull).since).toBe(at(2))
    }))
})
