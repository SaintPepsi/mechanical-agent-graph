import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { codeToVisionReview } from "mag/graphs/code-to-vision-review/graph"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { type RootEnv, RunRootEnv } from "mag/runtime/run-layers"
import { journalPathFor } from "mag/runtime/run-root"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir } from "mag/test/node-fixture"
import { RunId } from "mag/runtime/trace/layer"

const RUN_ID = "20260825000000-c0de"
const FAKE_REPO_ROOT = "/fake-code-to-vision-repo"
// `stage-shipped-graph` hardwires the live `DEFAULT_GRAPHS_ROOT` (`create-graph-folder`'s own
// precedent) — `design-graph` is a real shipped graph with a real committed vision.md, so this test
// exercises the whole pipeline against real staged code rather than a synthetic fixture tree.
const INPUT = { name: "design-graph" }

/** Every subprocess `runScopedLayers`/`runInfoLayer` make: the toplevel read, the two HEAD lookups (`envision/graph.test.ts`'s
 *  own `runShell`) and the common-dir identity probe — one answer for both sides, so the run is against this repository and `recordsRoot` is the checkout. */
const runShell = (): ShellService => ({
  run: (argv): Effect.Effect<ShellResult> => {
    const line = argv.join(" ")
    if (line === "git rev-parse --show-toplevel") return Effect.succeed({ exitCode: 0, stdout: `${FAKE_REPO_ROOT}\n`, stderr: "" })
    if (line === "git rev-parse --path-format=absolute --git-common-dir") return Effect.succeed({ exitCode: 0, stdout: `${FAKE_REPO_ROOT}/.git\n`, stderr: "" })
    if (line === "git rev-parse HEAD") return Effect.succeed({ exitCode: 0, stdout: "abc123\n", stderr: "" })
    throw new Error(`runShell: unexpected argv: ${line}`)
  }
})

/** `derive-vision` is the only one of the three nodes that dispatches — routing by destination is
 * trivial here (`design-graph/graph.test.ts`'s `destinationOf`, one route instead of three). */
const destinationOf = (prompt: string): string => {
  const match = prompt.match(/Write the drawing to `([^`]+)`/)
  if (match === null || match[1] === undefined) throw new Error(`no destination in prompt: ${prompt.slice(0, 160)}`)
  return match[1]
}

const runAgent = () => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      const destination = destinationOf(request.prompt)
      // A single step, deliberately unlike the shipped `design-graph` vision, so this is a
      // real derivation the report can find real divergence against.
      writeFileSync(destination, '```mermaid\ngraph TD\n  A["load · Mechanical<br/>job"]\n```\n')
      return Effect.succeed({
        verdict: { derivedVisionPath: destination } as A,
        result: {},
        sessions: ["session-derive-vision"],
        costUsd: 0.4,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const tempRoot = (): RootEnv => ({
  env: { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "code-to-vision-review-root-")) },
  home: "/unused"
})

const runGraph = (root: RootEnv, agent: ClaudeAgentService) =>
  Effect.runPromise(
    Effect.result(
      codeToVisionReview.run(INPUT).pipe(
        Effect.provideService(RunRootEnv, root),
        Effect.provideService(RunId, RUN_ID),
        Effect.provide(shellLayer(runShell())),
        Effect.provide(claudeAgentLayer(agent))
      )
    )
  )

describe("codeToVisionReview", () => {
  test("wears the GraphNode shape, so the registry can run it with no graph runner", () => {
    expect(codeToVisionReview.name).toBe("code-to-vision-review")
  })

  test("stages, derives and compares in order, and a real divergence comes back as named findings", async () => {
    const root = tempRoot()
    const agent = runAgent()
    try {
      const result = await runGraph(root, agent.service)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const success = result.success

      expect(success.name).toBe("design-graph")
      expect(existsSync(success.visionPath)).toBe(true)
      expect(existsSync(success.derivedVisionPath)).toBe(true)
      expect(existsSync(success.reportPath)).toBe(true)
      expect(readFileSync(success.reportPath, "utf8")).toContain(success.visionPath)

      // The shipped `design-graph` vision carries far more than one node — a real divergence
      // against the stub's single-node drawing surfaces as named findings, not an empty list.
      expect(success.divergent).toBe(true)
      expect(success.findings.length).toBeGreaterThan(0)
      expect(success.findings.every((finding) => typeof finding.kind === "string" && finding.name.length > 0)).toBe(true)

      expect(success.sessions).toStrictEqual(["session-derive-vision"])
      expect(success.costUsd).toBe(0.4)

      // Blindness held: the one dispatch never named the shipped vision's own path.
      expect(agent.requests).toHaveLength(1)
      expect(agent.requests[0]!.prompt).not.toContain(success.visionPath)

      // The staged `codeRoot` (the session's own `cwd`) is scratch the pipeline owns
      // and removes once compare-vision has read the drawing, so a run leaves no OS temp tree behind.
      const codeRoot = agent.requests[0]!.cwd
      expect(typeof codeRoot).toBe("string")
      expect(existsSync(codeRoot!)).toBe(false)

      const path = journalPathFor({ ...root, repoPath: FAKE_REPO_ROOT, ticket: INPUT.name, runId: RUN_ID })
      const rows = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row["event"] === "end")
      expect(rows.map((row) => row["node"])).toStrictEqual(["stage-shipped-graph", "derive-vision", "compare-vision"])
    } finally {
      await removeDir(String(root.env["CLAUDE_CONFIG_DIR"]))
    }
  })
})
