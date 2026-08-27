import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import {
  EnvisionMermaidCommitFailed,
  EnvisionMermaidGitFailed,
  EnvisionMermaidRunRootMissing,
  VisionMissing
} from "mag/graph-nodes/envision-mermaid/errors"
import { envisionMermaid, VISION_FILENAME } from "mag/graph-nodes/envision-mermaid/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/envision-mermaid/examples"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!

/** Records the argv `record`'s commit half sends; replies success by default, `git diff --cached --quiet` exit 1 so a commit always fires. */
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
/** `git add` ok, `git diff --cached --quiet` exit 1 (staged), `git commit` ok — every success test needs this shape, the commit is unconditional. */
const commitsCleanly = () => scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, ok()])

/**
 * `write` stands in for the session's own filesystem side effect (`design/graph-node.test.ts`'s
 * idiom), fired inside `prompt` so it lands between the node's before-dispatch snapshot and its
 * after-dispatch read — a file written before `.run()` is called would be indistinguishable from a
 * stale re-run under the node's own before/after compare.
 */
const stubAgent = (write?: () => void) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      write?.()
      return Effect.succeed({
        verdict: { visionPath: "ignored — the node uses its own computed path" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.12,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** The one dispatch every test makes; only the stubbed agent and the shell differ. */
const runNode = (folder: string, workRoot: string, runRoot: string, agent: ClaudeAgentService, shell: ShellService) =>
  Effect.runPromise(
    Effect.result(
      envisionMermaid.run({ folder, name: INPUT.name }).pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, testRunInfo({ workRoot, runRoot }))
      )
    )
  )

/** `workRoot`, the folder created inside it, and a disposable `runRoot` — `requireRunRoot`'s own precheck needs it non-empty. */
const withFolder = async <T>(fn: (folder: string, workRoot: string, runRoot: string) => Promise<T>): Promise<T> => {
  const base = mkdtempSync(join(tmpdir(), "envision-mermaid-"))
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

describe("envisionMermaid", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(envisionMermaid.input)) throw new Error("envisionMermaid.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(envisionMermaid.input)(example)
    if (!isSchemaHandle(envisionMermaid.success)) throw new Error("envisionMermaid.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(envisionMermaid.success)(example)
  })

  test("dispatches with no agent and no model — the basic tier is the session default", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent()
      await runNode(folder, workRoot, runRoot, agent.service, commitsCleanly().service)

      expect(agent.requests).toHaveLength(1)
      expect(agent.requests[0]!.agent).toBeUndefined()
      expect(agent.requests[0]!.model).toBeUndefined()
      expect(agent.requests[0]!.cwd).toBe(workRoot)
    }))

  test("the prompt names the vision's own destination and the graph name, never the rail-sketch", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent()
      await runNode(folder, workRoot, runRoot, agent.service, commitsCleanly().service)

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(`${folder}/${VISION_FILENAME}`)
      expect(prompt).toContain(INPUT.name)
      expect(prompt).not.toContain("rail-sketch.md")
    }))

  test("a written vision is committed unconditionally, pathspec-scoped to vision.md alone", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent(() => writeFileSync(`${folder}/${VISION_FILENAME}`, "graph TD\n  A --> B\n"))
      const { calls, service: shell } = commitsCleanly()

      const result = await runNode(folder, workRoot, runRoot, agent.service, shell)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        visionPath: `${folder}/${VISION_FILENAME}`,
        sessions: ["stub-session"],
        costUsd: 0.12
      })
      expect(calls[0]).toStrictEqual(["git", "add", "--", `${folder}/${VISION_FILENAME}`])
      expect(calls[1]).toStrictEqual(["git", "diff", "--cached", "--quiet", "--", `${folder}/${VISION_FILENAME}`])
      expect(calls[2]).toStrictEqual([
        "git",
        "commit",
        "-m",
        `envision: vision committed by envision-mermaid\n\nClaude-Session: stub-session`,
        "--",
        `${folder}/${VISION_FILENAME}`
      ])
    }))

  test("a session that never wrote vision.md is VisionMissing, carrying the path and the sessions spent", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const result = await runNode(folder, workRoot, runRoot, stubAgent().service, commitsCleanly().service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VisionMissing)
      const failure = result.failure as VisionMissing
      expect(failure.path).toBe(`${folder}/${VISION_FILENAME}`)
      expect(failure.sessions).toStrictEqual(["stub-session"])
      expect(existsSync(`${folder}/${VISION_FILENAME}`)).toBe(false)
    }))

  test("a blank vision file is VisionMissing too — nothing for rail-sketch to read", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      writeFileSync(`${folder}/${VISION_FILENAME}`, "  \n")
      const result = await runNode(folder, workRoot, runRoot, stubAgent().service, scriptedShell([]).service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VisionMissing)
    }))

  test("a re-run's stale vision.md is VisionMissing when the session leaves it untouched", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      // Re-runs overwrite in place, so on a second `mag envision` the destination already holds
      // the prior run's committed vision. "present, non-empty" alone must not pass a session that
      // dispatched and wrote nothing — dropping the `written === before` disjunct turns this
      // failure into a false success.
      writeFileSync(`${folder}/${VISION_FILENAME}`, "graph TD\n  A --> B\n")
      const { calls, service: shell } = scriptedShell([])
      const result = await runNode(folder, workRoot, runRoot, stubAgent().service, shell)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VisionMissing)
      // Never reaches the commit: no stray record of a no-op session's leftovers.
      expect(calls).toHaveLength(0)
    }))

  test("an empty run root fails EnvisionMermaidRunRootMissing before any dispatch", () =>
    withFolder(async (folder, workRoot) => {
      const agent = stubAgent(() => writeFileSync(`${folder}/${VISION_FILENAME}`, "graph TD\n"))
      const result = await runNode(folder, workRoot, "", agent.service, scriptedShell([]).service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(EnvisionMermaidRunRootMissing)
      // The gate sits above the dispatch, so the session is never paid for.
      expect(agent.requests).toHaveLength(0)
    }))

  test("a failed add fails EnvisionMermaidGitFailed", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent(() => writeFileSync(`${folder}/${VISION_FILENAME}`, "graph TD\n"))
      const failing = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: bad pathspec\n" }])
      const result = await runNode(folder, workRoot, runRoot, agent.service, failing.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(EnvisionMermaidGitFailed)
    }))

  test("a failed commit fails EnvisionMermaidCommitFailed, sessions attached", () =>
    withFolder(async (folder, workRoot, runRoot) => {
      const agent = stubAgent(() => writeFileSync(`${folder}/${VISION_FILENAME}`, "graph TD\n"))
      const failing = scriptedShell([
        ok(),
        { exitCode: 1, stdout: "", stderr: "" },
        { exitCode: 1, stdout: "", stderr: "fatal: empty ident name\n" }
      ])
      const result = await runNode(folder, workRoot, runRoot, agent.service, failing.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(EnvisionMermaidCommitFailed)
      expect((result.failure as EnvisionMermaidCommitFailed).sessions).toStrictEqual(["stub-session"])
    }))
})
