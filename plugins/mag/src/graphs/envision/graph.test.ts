import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer, Result } from "effect"
import { VISION_FILENAME } from "mag/graph-nodes/envision-mermaid/graph-node"
import { RAIL_SKETCH_FILENAME } from "mag/graph-nodes/envision-rail-sketch/graph-node"
import { envision } from "mag/graphs/envision/graph"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { DEFAULT_GRAPHS_ROOT, isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunRootEnv } from "mag/runtime/run-layers"
import { journalPathFor, runDirFor } from "mag/runtime/run-root"
import { type ShellService, shellLayer } from "mag/runtime/shell"
import { RunId } from "mag/runtime/trace/layer"

/**
 * `envision`'s first node, `create-graph-folder`, hardwires the live `DEFAULT_GRAPHS_ROOT`
 * (`create-graph-folder/graph-node.test.ts`'s own doc comment explains why: the folder needs to
 * live IN the repo source tree, not a redirectable input). A graph-level run of `envision` therefore
 * touches the real tree for the two artifact writes below — unlike `graphs/develop-graph/graph.test.ts`, which
 * stays entirely inside a synthetic temp repo because none of ITS nodes hardwire a path outside
 * `RunInfo`. `FIXTURE_NAME` is disposable and removed in `finally` regardless of outcome; every git
 * call is stubbed, so nothing is ever actually committed.
 */
const FIXTURE_NAME = "gh287-envision-graph-test-fixture"
const FIXTURE_FOLDER = join(DEFAULT_GRAPHS_ROOT, FIXTURE_NAME)

const RUN_ID = "20260823000000-a1b2"
const FAKE_REPO_ROOT = "/fake-envision-repo"

/**
 * Deletes exactly one of the two paths this test creates and nothing else. The sibling guard
 * (`create-graph-folder/graph-node.test.ts`, `envision-mermaid/graph-node.test.ts`) refuses anything
 * outside `tmpdir()`; this copy's fixture target is legitimately outside it (the real source tree,
 * `FIXTURE_FOLDER` above), so the guard is an exact-match allowlist instead — a wrong path here is
 * not a slow test, it is a recursive delete inside the checkout.
 */
const removeDir = (path: string): Promise<void> => {
  if (path !== FIXTURE_FOLDER && !path.startsWith(tmpdir())) {
    throw new Error(`removeDir: refusing to delete unrecognized path: ${path}`)
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

/** Every subprocess `envision` makes: `runScopedLayers`'s toplevel read, `runInfoValues`' sha/pipelineSha lookups, and two `commitPath` spines. */
const runShell = (): ShellService => ({
  run: (argv) => {
    const line = argv.join(" ")
    if (line === "git rev-parse --show-toplevel") return Effect.succeed({ exitCode: 0, stdout: `${FAKE_REPO_ROOT}\n`, stderr: "" })
    // `runInfoValues`' own sha and pipelineSha lookups (`run-info-layer.ts`) — one call per checkout,
    // both answered by this one route since the stub matches on argv alone.
    if (line === "git rev-parse HEAD") return Effect.succeed({ exitCode: 0, stdout: "abc123\n", stderr: "" })
    // run-layers's identity check — one answer for both sides keeps this a home run.
    if (line === "git rev-parse --path-format=absolute --git-common-dir") {
      return Effect.succeed({ exitCode: 0, stdout: `${FAKE_REPO_ROOT}/.git\n`, stderr: "" })
    }
    if (argv[0] === "git" && argv[1] === "add") return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
    if (argv[0] === "git" && argv[1] === "diff") return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
    if (argv[0] === "git" && argv[1] === "commit") return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
    throw new Error(`runShell: unexpected argv: ${line}`)
  }
})

/** Routes by which destination the prompt names — the two dispatches' own disconfirming shape. */
const runAgent = () => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      if (request.prompt.includes(VISION_FILENAME) && !request.prompt.includes(RAIL_SKETCH_FILENAME)) {
        writeFileSync(`${FIXTURE_FOLDER}/${VISION_FILENAME}`, "graph TD\n  A --> B\n")
        return Effect.succeed({
          verdict: { visionPath: `${FIXTURE_FOLDER}/${VISION_FILENAME}` } as A,
          result: {},
          sessions: ["session-mermaid"],
          costUsd: 0.25,
          attempts: 1
        } as ClaudeReply<A>)
      }
      writeFileSync(`${FIXTURE_FOLDER}/${RAIL_SKETCH_FILENAME}`, "### create-graph-folder\n\ninput { name: string }\n")
      return Effect.succeed({
        verdict: { sketchPath: `${FIXTURE_FOLDER}/${RAIL_SKETCH_FILENAME}` } as A,
        result: {},
        sessions: ["session-rail-sketch"],
        costUsd: 0.5,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

describe("envision", () => {
  test("wears the GraphNode shape, so the registry can run it with no graph runner", () => {
    expect(isSchemaHandle(envision.input)).toBe(true)
    expect(isSchemaHandle(envision.success)).toBe(true)
    expect(envision.name).toBe("envision")
  })

  test("two dispatches in order, correct tiers, destinations inside the created folder, a journal row per node", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "envision-graph-"))
    try {
      // The run scope the graph composes for itself, spelled once: `RunRootEnv` reads its `env`/`home`
      // half, `runDirFor`/`journalPathFor` read the whole of it.
      const scope = {
        env: { CLAUDE_CONFIG_DIR: configDir },
        home: "/unused",
        repoPath: FAKE_REPO_ROOT,
        ticket: FIXTURE_NAME,
        runId: RUN_ID
      }
      const shell = runShell()
      const agent = runAgent()

      const result = await Effect.runPromise(
        Effect.result(
          envision.run({ name: FIXTURE_NAME }).pipe(
            Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent.service))),
            Effect.provideService(RunId, RUN_ID),
            Effect.provideService(RunRootEnv, scope)
          )
        )
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        folder: FIXTURE_FOLDER,
        visionPath: `${FIXTURE_FOLDER}/${VISION_FILENAME}`,
        sketchPath: `${FIXTURE_FOLDER}/${RAIL_SKETCH_FILENAME}`,
        costUsd: 0.75,
        sessions: ["session-mermaid", "session-rail-sketch"]
      })

      // Both artifacts landed inside the folder the first node created, under the graphs root.
      expect(existsSync(`${FIXTURE_FOLDER}/${VISION_FILENAME}`)).toBe(true)
      expect(existsSync(`${FIXTURE_FOLDER}/${RAIL_SKETCH_FILENAME}`)).toBe(true)

      // envision-mermaid carries neither agent nor model (basic tier); envision-rail-sketch is effect-expert.
      expect(agent.requests).toHaveLength(2)
      expect(agent.requests[0]!.agent).toBeUndefined()
      expect(agent.requests[0]!.model).toBeUndefined()
      expect(agent.requests[1]!.agent).toBe("effect-expert")

      // The disconfirming half at the graph level: each prompt names only its own destination.
      expect(agent.requests[0]!.prompt).not.toContain(RAIL_SKETCH_FILENAME)
      expect(agent.requests[1]!.prompt).toContain(`${FIXTURE_FOLDER}/${VISION_FILENAME}`)

      const path = journalPathFor(scope)
      expect(path).toBe(`${runDirFor(scope)}/journal.jsonl`)
      const rows = readFileSync(path, "utf8")
        .split("\n")
        .filter((row) => row.trim() !== "")
        .map((row) => JSON.parse(row) as Record<string, unknown>)
      expect(rows.map((row) => [row["node"], row["event"]])).toStrictEqual([
        ["create-graph-folder", "start"],
        ["create-graph-folder", "end"],
        ["envision-mermaid", "start"],
        ["envision-mermaid", "end"],
        ["envision-rail-sketch", "start"],
        ["envision-rail-sketch", "end"]
      ])
    } finally {
      if (existsSync(FIXTURE_FOLDER)) await removeDir(FIXTURE_FOLDER)
      await removeDir(configDir)
    }
  })
})
