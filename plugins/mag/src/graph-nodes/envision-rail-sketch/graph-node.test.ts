import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import {
  EnvisionRailSketchCommitFailed,
  EnvisionRailSketchGitFailed,
  EnvisionRailSketchRunRootMissing,
  RailSketchMissing
} from "mag/graph-nodes/envision-rail-sketch/errors"
import { envisionRailSketch, RAIL_SKETCH_FILENAME } from "mag/graph-nodes/envision-rail-sketch/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/envision-rail-sketch/examples"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!
const WITH_AGENT = inputExamples[1]!

const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: string[][] = []
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const ok = (): ShellResult => ({ exitCode: 0, stdout: "", stderr: "" })
const commitsCleanly = () => scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, ok()])

/**
 * `write` stands in for the session's own filesystem side effect, fired inside `prompt` so it lands
 * between the node's before-dispatch snapshot and its after-dispatch read (`envision-mermaid`'s own
 * fixture, mirrored).
 */
const stubAgent = (write?: () => void) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      write?.()
      return Effect.succeed({
        verdict: { sketchPath: "ignored — the node uses its own computed path" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.4,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** The one dispatch every test makes; only the stubbed agent, the shell and the input fixture differ. */
const runNode = (
  folder: string,
  workRoot: string,
  runRoot: string,
  agent: ClaudeAgentService,
  shell: ShellService,
  input = INPUT
) =>
  Effect.runPromise(
    Effect.result(
      envisionRailSketch.run({ ...input, folder }).pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, testRunInfo({ workRoot, runRoot }))
      )
    )
  )

/** `workRoot`, the folder created inside it, and a disposable `runRoot` — `requireRunRoot`'s own precheck needs it non-empty. */
const withFolder = async <T>(fn: (folder: string, workRoot: string, runRoot: string) => Promise<T>): Promise<T> => {
  const base = mkdtempSync(join(tmpdir(), "envision-rail-sketch-"))
  const workRoot = join(base, "work")
  const runRoot = join(base, "run")
  const folder = join(workRoot, "graphs", "envision")
  mkdirSync(folder, { recursive: true })
  mkdirSync(runRoot, { recursive: true })
  try {
    return await fn(folder, workRoot, runRoot)
  } finally {
    await removeDir(base)
  }
}

describe("envisionRailSketch", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(envisionRailSketch.input)) throw new Error("envisionRailSketch.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(envisionRailSketch.input)(example)
    if (!isSchemaHandle(envisionRailSketch.success)) throw new Error("envisionRailSketch.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(envisionRailSketch.success)(example)
  })

  test("the input's agent and model reach the dispatch verbatim; without one, none is sent", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const bare = stubAgent()
      await runNode(folder, workRoot, runRoot, bare.service, commitsCleanly().service)
      expect(bare.requests[0]!.agent).toBeUndefined()
      expect(bare.requests[0]!.model).toBeUndefined()

      const hardwired = stubAgent()
      await runNode(folder, workRoot, runRoot, hardwired.service, commitsCleanly().service, WITH_AGENT)
      expect(hardwired.requests[0]!.agent).toBe("effect-expert")
      expect(hardwired.requests[0]!.model).toBe("opus")
    }))

  test("the prompt names the vision as read-only input and rail-sketch.md as its own destination", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent()
      await runNode(folder, workRoot, runRoot, agent.service, commitsCleanly().service)

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(INPUT.visionPath)
      expect(prompt).toContain(`${folder}/${RAIL_SKETCH_FILENAME}`)
    }))

  test("a written sketch is committed unconditionally, pathspec-scoped to rail-sketch.md alone", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent(() =>
        writeFileSync(`${folder}/${RAIL_SKETCH_FILENAME}`, "### create-graph-folder\n\ninput { name: string }\n"))
      const { calls, service: shell } = commitsCleanly()

      const result = await runNode(folder, workRoot, runRoot, agent.service, shell)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        sketchPath: `${folder}/${RAIL_SKETCH_FILENAME}`,
        sessions: ["stub-session"],
        costUsd: 0.4
      })
      expect(calls[0]).toStrictEqual(["git", "add", "--", `${folder}/${RAIL_SKETCH_FILENAME}`])
      expect(calls[1]).toStrictEqual(["git", "diff", "--cached", "--quiet", "--", `${folder}/${RAIL_SKETCH_FILENAME}`])
      expect(calls[2]).toStrictEqual([
        "git",
        "commit",
        "-m",
        `envision: rail-sketch committed by envision-rail-sketch\n\nClaude-Session: stub-session`,
        "--",
        `${folder}/${RAIL_SKETCH_FILENAME}`
      ])
    }))

  test("a session that never wrote rail-sketch.md is RailSketchMissing", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const result = await runNode(folder, workRoot, runRoot, stubAgent().service, scriptedShell([]).service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RailSketchMissing)
      expect(existsSync(`${folder}/${RAIL_SKETCH_FILENAME}`)).toBe(false)
    }))

  test("a blank rail-sketch.md is RailSketchMissing too — whitespace is nothing to build from", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent(() => writeFileSync(`${folder}/${RAIL_SKETCH_FILENAME}`, "  \n"))
      const { calls, service: shell } = scriptedShell([])
      const result = await runNode(folder, workRoot, runRoot, agent.service, shell)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RailSketchMissing)
      // Never reaches the commit: a whitespace-only file is not a sketch worth recording.
      expect(calls).toHaveLength(0)
    }))

  test("a re-run's stale rail-sketch.md is RailSketchMissing when the session leaves it untouched", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      // Same hole as `envision-mermaid`'s, closed the same way: also covers a stray mermaid-session
      // write landing on rail-sketch.md before this node's own dispatch — that stray becomes the
      // "before" snapshot, so a rail-sketch session that doesn't independently write still fails.
      writeFileSync(`${folder}/${RAIL_SKETCH_FILENAME}`, "### create-graph-folder\n\ninput { name: string }\n")
      const { calls, service: shell } = scriptedShell([])
      const result = await runNode(folder, workRoot, runRoot, stubAgent().service, shell)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RailSketchMissing)
      expect(calls).toHaveLength(0)
    }))

  test("an empty run root fails EnvisionRailSketchRunRootMissing before any dispatch", () =>
    withFolder(async (folder, workRoot) => {
      const agent = stubAgent(() => writeFileSync(`${folder}/${RAIL_SKETCH_FILENAME}`, "### a node\n"))
      const result = await runNode(folder, workRoot, "", agent.service, scriptedShell([]).service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(EnvisionRailSketchRunRootMissing)
      // The gate sits above the dispatch, so the session is never paid for.
      expect(agent.requests).toHaveLength(0)
    }))

  test("a failed add fails EnvisionRailSketchGitFailed", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent(() => writeFileSync(`${folder}/${RAIL_SKETCH_FILENAME}`, "### a node\n"))
      const failing = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: bad pathspec\n" }])
      const result = await runNode(folder, workRoot, runRoot, agent.service, failing.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(EnvisionRailSketchGitFailed)
    }))

  test("a failed commit fails EnvisionRailSketchCommitFailed, sessions attached", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent(() => writeFileSync(`${folder}/${RAIL_SKETCH_FILENAME}`, "### a node\n"))
      const failing = scriptedShell([
        ok(),
        { exitCode: 1, stdout: "", stderr: "" },
        { exitCode: 1, stdout: "", stderr: "fatal: empty ident name\n" }
      ])
      const result = await runNode(folder, workRoot, runRoot, agent.service, failing.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(EnvisionRailSketchCommitFailed)
      expect((result.failure as EnvisionRailSketchCommitFailed).sessions).toStrictEqual(["stub-session"])
    }))
})
