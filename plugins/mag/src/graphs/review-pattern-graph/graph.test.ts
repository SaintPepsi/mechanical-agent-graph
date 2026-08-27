import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer, Result } from "effect"
import { WindowNotFull } from "mag/graph-nodes/gather-reviews/errors"
import { reviewPatternGraph } from "mag/graphs/review-pattern-graph/graph"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunRootEnv } from "mag/runtime/run-layers"
import { journalPathFor, runDirFor } from "mag/runtime/run-root"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { RunId } from "mag/runtime/trace/layer"

/**
 * Two runs over a temp graph root. A full window asserts the journal's
 * row order and that the comment argv names the report path the analysis wrote. A short window
 * asserts the run ends at `gather-reviews` with `WINDOW_NOT_FULL` and no agent dispatch at all,
 * since a trigger that is not mechanical is a trigger that spends a session finding out
 * there was nothing to do.
 */

const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

const RUN_ID = "20260821000000-9999"
const REPO_ROOT = "/repo/top"

const at = (minute: number): string => `2026-08-20T00:${String(minute).padStart(2, "0")}:00.000Z`

/** One run directory holding a single clean review-diff pass and its findings artifact — the "no send-backs" fixture, which keeps the stub verdict trivial: `sendBacks: []` satisfies an all-clean window. */
const writeCleanReviewRun = (graphRootDir: string, runId: string, endedAt: string): void => {
  const dir = join(graphRootDir, "fixture-project", "GH-197", runId)
  mkdirSync(dir, { recursive: true })
  const stamp = { runId, ticket: "GH-197", graph: "develop-graph", repoRoot: "/other-repo", sha: "tree", pipelineSha: "def4567" }
  const rows = [
    { schema: "graph/journal@3", ...stamp, node: "review-diff", attempt: 1, event: "start", timestamp: endedAt },
    {
      schema: "graph/journal@3",
      ...stamp,
      node: "review-diff",
      attempt: 1,
      event: "end",
      timestamp: endedAt,
      replayed: false,
      input: { headSha: runId },
      outcome: "ok",
      success: { findingsPath: "unused", headSha: runId, sessions: ["s1"], costUsd: 0.1 }
    }
  ]
  writeFileSync(join(dir, "journal.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
  writeFileSync(join(dir, "review-diff-1.md"), `Reviewed at ${runId}\n\nNo blocking findings.`)
}

const runShell = () => {
  const calls: string[][] = []
  const service: ShellService = {
    run: (argv): Effect.Effect<ShellResult, never> => {
      calls.push([...argv])
      const line = argv.join(" ")
      if (line === "git rev-parse --show-toplevel") return Effect.succeed({ exitCode: 0, stdout: `${REPO_ROOT}\n`, stderr: "" })
      // runInfoValues' own sha/pipelineSha reads (run-info-layer.ts) — unrelated to this graph's logic, just labels it stamps on every row.
      if (line === "git rev-parse HEAD") return Effect.succeed({ exitCode: 0, stdout: "deadbeef\n", stderr: "" })
      // run-layers's identity check — one answer for both sides keeps this a home run.
      if (line === "git rev-parse --path-format=absolute --git-common-dir") {
        return Effect.succeed({ exitCode: 0, stdout: `${REPO_ROOT}/.git\n`, stderr: "" })
      }
      // comment-ticket posts through gh directly, body via --body-file.
      if (line.startsWith("gh issue comment 213 --body-file")) return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
      throw new Error(`runShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

const stubAgent = (): { readonly requests: Array<ClaudePrint<unknown>>; readonly service: ClaudeAgentService } => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { sendBacks: [], patterns: [], note: "clean window, converging" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.42,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const withGraphRoot = async (fn: (graphRootDir: string, configDir: string) => Promise<void>): Promise<void> => {
  const configDir = mkdtempSync(join(tmpdir(), "review-pattern-graph-"))
  const graphRootDir = join(configDir, "graph")
  mkdirSync(graphRootDir, { recursive: true })
  try {
    await fn(graphRootDir, configDir)
  } finally {
    await removeDir(configDir)
  }
}

const runGraph = (configDir: string, shell: ShellService, agent: ClaudeAgentService) =>
  Effect.runPromise(
    Effect.result(
      reviewPatternGraph.run({ reportTicket: "GH-213" }).pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunId, RUN_ID),
        Effect.provideService(RunRootEnv, { env: { CLAUDE_CONFIG_DIR: configDir }, home: "/unused" })
      )
    )
  )

describe("review-pattern-graph", () => {
  test("wears the GraphNode shape, so the registry can run it with no graph runner", () => {
    expect(isSchemaHandle(reviewPatternGraph.input)).toBe(true)
    expect(isSchemaHandle(reviewPatternGraph.success)).toBe(true)
    expect(reviewPatternGraph.name).toBe("review-pattern-graph")
  })

  test("a short window ends at gather-reviews with WINDOW_NOT_FULL, and dispatches no agent at all", () =>
    withGraphRoot(async (graphRootDir, configDir) => {
      writeCleanReviewRun(graphRootDir, "run-1", at(1))
      writeCleanReviewRun(graphRootDir, "run-2", at(2))

      const { service: shell } = runShell()
      const agent = stubAgent()
      const result = await runGraph(configDir, shell, agent.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(WindowNotFull)
      expect(agent.requests).toHaveLength(0)
    }))

  test("a full window runs all three nodes in order, and the comment names the report the analysis wrote", () =>
    withGraphRoot(async (graphRootDir, configDir) => {
      for (let n = 1; n <= 5; n++) writeCleanReviewRun(graphRootDir, `run-${n}`, at(n))

      const { calls, service: shell } = runShell()
      const agent = stubAgent()
      const result = await runGraph(configDir, shell, agent.service)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return

      const runRoot = runDirFor({
        env: { CLAUDE_CONFIG_DIR: configDir },
        home: "/unused",
        repoPath: REPO_ROOT,
        ticket: "GH-213",
        runId: RUN_ID
      })
      expect(result.success).toStrictEqual({
        ticket: "GH-213",
        manifestPath: `${runRoot}/window.json`,
        reportPath: `${runRoot}/review-patterns-1.md`,
        passes: 5,
        sendBacks: 0,
        through: at(5),
        sessions: ["stub-session"],
        costUsd: 0.42
      })
      expect(existsSync(`${runRoot}/window.json`)).toBe(true)
      expect(existsSync(`${runRoot}/review-patterns-1.md`)).toBe(true)

      // The comment posts exactly the file the analysis wrote — no path this graph invented itself.
      const commentCall = calls.find((argv) => argv[0] === "gh" && argv[1] === "issue" && argv[2] === "comment")
      expect(commentCall).toStrictEqual(["gh", "issue", "comment", "213", "--body-file", `${runRoot}/review-patterns-1.md`])

      // One journal, the three nodes in the pipeline's own order, every row this run's id.
      const path = journalPathFor({
        env: { CLAUDE_CONFIG_DIR: configDir },
        home: "/unused",
        repoPath: REPO_ROOT,
        ticket: "GH-213",
        runId: RUN_ID
      })
      const rows = readFileSync(path, "utf8")
        .split("\n")
        .filter((row) => row.trim() !== "")
        .map((row) => JSON.parse(row) as Record<string, unknown>)
      expect(rows.map((row) => [row["node"], row["event"]])).toStrictEqual([
        ["gather-reviews", "start"],
        ["gather-reviews", "end"],
        ["analyse-reviews", "start"],
        ["analyse-reviews", "end"],
        ["comment-ticket", "start"],
        ["comment-ticket", "end"]
      ])
      for (const row of rows) {
        expect(row["runId"]).toBe(RUN_ID)
        expect(row["ticket"]).toBe("GH-213")
        expect(row["graph"]).toBe("review-pattern-graph")
      }
      for (const row of rows.filter((row) => row["event"] === "end")) {
        expect(row["outcome"]).toBe("ok")
      }
    }))
})
