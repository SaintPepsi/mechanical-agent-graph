import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/recycle-map/examples"
import { RecycleMapCommitFailed, RecycleMapMissing } from "mag/graph-nodes/recycle-map/errors"
import { recycleMap } from "mag/graph-nodes/recycle-map/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { compileRecycleMap } from "mag/skills/recycle-map"
import { scriptedShell, withRecordRepo } from "mag/test/node-fixture"

const out = (): ShellResult => ({ exitCode: 0, stdout: "", stderr: "" })
/** `git add` ok, `git diff --cached --quiet` exit 1 (staged), `git commit` ok, the `records: "committed"` shape. */
const commitsCleanly = () => scriptedShell([out(), { exitCode: 1, stdout: "", stderr: "" }, out()])

const INPUT = inputExamples[0]!

const mapIn = (repoRoot: string): string => join(repoRoot, "docs", "graph", INPUT.ticket, "recycle-map.md")

/**
 * An agent whose session writes the map at the node's own computed path, inside `prompt`, so the
 * write lands between the node's before-snapshot and its after-read; `repoRoot: undefined` is a
 * session that declared success and wrote nothing.
 */
const writingAgent = (repoRoot: string | undefined) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      if (repoRoot !== undefined) {
        mkdirSync(dirname(mapIn(repoRoot)), { recursive: true })
        writeFileSync(mapIn(repoRoot), "Reuse: `foo.ts:1` already covers this.")
      }
      return Effect.succeed({
        verdict: { recycleMapPath: "docs/graph/GH-258/recycle-map.md" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.18,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, shell: ShellService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

const withRepo = <T>(fn: (repoRoot: string, runRoot: string, run: RunInfoService) => Promise<T>): Promise<T> =>
  withRecordRepo("recycle-map-node", fn)

describe("recycle-map", () => {
  test("the fixtures decode against recycle-map's own schemas", () => {
    if (!isSchemaHandle(recycleMap.input)) throw new Error("recycleMap.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(recycleMap.input)(example)
    if (!isSchemaHandle(recycleMap.success)) throw new Error("recycleMap.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(recycleMap.success)(example)
  })

  test("the prompt cites the ticket and the discover note by path, names its own destination, and carries the standard", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = writingAgent(undefined)
      await runWith(recycleMap.run(INPUT), agent.service, scriptedShell([]).service, run)

      expect(agent.requests).toHaveLength(1)
      const request = agent.requests[0]!
      expect(request.cwd).toBe(repoRoot)
      expect(request.prompt).toContain(`Read the ticket at \`${INPUT.ticketPath}\`.`)
      expect(request.prompt).toContain(`Read the discover note at \`${INPUT.discoverPath}\`.`)
      expect(request.prompt).toContain(`Write the map to \`${mapIn(repoRoot)}\`. Change nothing else.`)
      expect(request.prompt).toContain(compileRecycleMap())
      expect(request.prompt).toContain("What already exists that this task can reuse?")
    }))

  test("the input's agent and model reach the dispatch verbatim; without them, none is sent", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const bare = writingAgent(undefined)
      await runWith(recycleMap.run(INPUT), bare.service, scriptedShell([]).service, run)
      expect(bare.requests[0]!.agent).toBeUndefined()
      expect(bare.requests[0]!.model).toBeUndefined()

      const assigned = writingAgent(undefined)
      await runWith(recycleMap.run(inputExamples[1]!), assigned.service, scriptedShell([]).service, run)
      expect(assigned.requests[0]!.agent).toBe("effect-expert")
      expect(assigned.requests[0]!.model).toBe("opus")
    }))

  test("a written map is copied into the run root, success carries the computed path, no git call under the default policy", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const { calls, service } = scriptedShell([])
      const result = await runWith(recycleMap.run(INPUT), writingAgent(repoRoot).service, service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ recycleMapPath: mapIn(repoRoot), sessions: ["stub-session"], costUsd: 0.18 })
      expect(readFileSync(`${runRoot}/recycle-map.md`, "utf8")).toBe("Reuse: `foo.ts:1` already covers this.")
      expect(calls).toHaveLength(0)
    }))

  test("under records: \"committed\", a written map is also committed with a pathspec-scoped add and commit", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const { calls, service } = commitsCleanly()
      const result = await runWith(recycleMap.run(INPUT), writingAgent(repoRoot).service, service, { ...run, records: "committed" })

      expect(Result.isSuccess(result)).toBe(true)
      expect(calls[0]).toStrictEqual(["git", "add", "--", mapIn(repoRoot)])
      expect(calls[2]![1]).toBe("commit")
      expect(calls[2]!.at(-1)).toBe(mapIn(repoRoot))
    }))

  test("a session that never wrote the map is RecycleMapMissing, naming the computed path", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const result = await runWith(recycleMap.run(INPUT), writingAgent(undefined).service, scriptedShell([]).service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RecycleMapMissing)
      expect((result.failure as RecycleMapMissing).path).toBe(mapIn(repoRoot))
    }))

  test("under records: \"committed\", a failing add is RecycleMapCommitFailed carrying the sessions", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const failing = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: nope\n" }])
      const result = await runWith(recycleMap.run(INPUT), writingAgent(repoRoot).service, failing.service, { ...run, records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(RecycleMapCommitFailed)
      expect((result.failure as RecycleMapCommitFailed).sessions).toStrictEqual(["stub-session"])
    }))
})
