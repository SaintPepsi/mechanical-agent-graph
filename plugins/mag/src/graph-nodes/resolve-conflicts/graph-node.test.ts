import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/resolve-conflicts/examples"
import { resolveConflicts } from "mag/graph-nodes/resolve-conflicts/graph-node"
import { VerificationFailed } from "mag/graph-nodes/verification/errors"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })
const exit = (exitCode: number, stdout = "", stderr = ""): ShellResult => ({ exitCode, stdout, stderr })

/** detect-conflicts's own probe sequence, on a clean pair: both refs verify, merge-tree exits 0. */
const detectClean: readonly ShellResult[] = [out("bbb222\n"), out("aaa111\n"), out("ccc333\n")]

/** detect-conflicts's own probe sequence, on a conflicting pair, one path. */
const conflictStdout = ["oid", "f.txt", "", "1", "f.txt"].join("\0") + "\0"
const detectConflicted: readonly ShellResult[] = [out("bbb222\n"), out("aaa111\n"), exit(1, conflictStdout)]

/**
 * fix-conflicts's full sequence through a staged, proven, uncommitted tree (`fix-conflicts/graph-node.test.ts`'s
 * own fixture). `git add -A` runs before `--cached --check` — the check has to see the tree exactly
 * as staged, or a marker reintroduced after the resolver's own staging would reach the eventual
 * commit unchecked. There is no post-add "is anything staged" guard: a resolution equal to HEAD is a
 * legitimate outcome, not a vanished one — `commitMerge` still records the merge's two parents once
 * this composite calls it, after verification.
 */
const fixStaged: readonly ShellResult[] = [
  out(""), // status
  exit(1), // merge start: conflicted
  out("f.txt\0"), // pre-dispatch unmerged read
  out(""), // post-dispatch unmerged read: resolved
  out(""), // add -A
  exit(0), // conflict-marker check: clean
  out("ddd777\n") // write-tree: the staged tree's own id
]

/** `commitMerge`'s own sequence, run only once verification has passed. */
const commitSequence: readonly ShellResult[] = [
  out(""), // git commit
  out("eee555\n") // git rev-parse HEAD
]

const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { summary: "resolved f.txt" } as A,
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

const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "resolve-conflicts-node-"))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

const INPUT = inputExamples[0]!

const runWith = (
  effect: Effect.Effect<unknown, unknown, never>,
  shell: ShellService,
  agent: ClaudeAgentService,
  run: RunInfoService
) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

describe("resolve-conflicts", () => {
  test("the fixtures decode against resolve-conflicts's own schemas", () => {
    if (!isSchemaHandle(resolveConflicts.input)) throw new Error("resolveConflicts.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(resolveConflicts.input)(example)
    if (!isSchemaHandle(resolveConflicts.success)) throw new Error("resolveConflicts.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(resolveConflicts.success)(example)
  })

  test("a clean pair spends nothing — zero agent dispatches, zero verification calls, resolved: false", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([...detectClean])
      const stub = stubAgent()
      const result = await runWith(resolveConflicts.run(INPUT), service, stub.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        base: "main",
        target: "feat/gh-184-fix",
        conflicts: [],
        resolved: false,
        headSha: "bbb222",
        sessions: [],
        costUsd: 0
      })
      expect(stub.requests).toHaveLength(0)
      expect(calls.map((call) => call.argv.join(" "))).not.toContain(`sh -c ${INPUT.command}`)
      expect(calls).toHaveLength(3) // exactly detect-conflicts's own three probes
    }))

  test("a conflicting pair detects, fixes, verifies the staged tree, and only then commits — resolved: true", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([...detectConflicted, ...fixStaged, out("42 pass\n"), ...commitSequence])
      const stub = stubAgent()
      const result = await runWith(resolveConflicts.run(INPUT), service, stub.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        base: "main",
        target: "feat/gh-184-fix",
        conflicts: ["f.txt"],
        resolved: true,
        headSha: "eee555",
        sessions: ["stub-session"],
        costUsd: 0.42
      })
      expect(stub.requests).toHaveLength(1)
      // Verification runs against `fix-conflicts`'s own staged tree id, before the commit that follows it.
      const verifyIndex = calls.findIndex((call) => call.argv.join(" ") === `sh -c ${INPUT.command}`)
      const commitIndex = calls.findIndex((call) => call.argv[1] === "commit")
      expect(verifyIndex).toBeGreaterThan(-1)
      expect(commitIndex).toBeGreaterThan(verifyIndex)
    }))

  test("a red verification fails VerificationFailed — the staged tree is never committed", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([
        ...detectConflicted,
        ...fixStaged,
        exit(1, "1 fail\n", "typecheck error")
      ])
      const stub = stubAgent()
      const result = await runWith(resolveConflicts.run(INPUT), service, stub.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VerificationFailed)
      // Exactly detect (3) + fix (7) + verification (1) — nothing beyond the suite's own failed
      // call, and specifically no `git commit`: a red suite never reaches it.
      expect(calls).toHaveLength(11)
      expect(calls.map((call) => call.argv[1])).not.toContain("commit")
    }))

  test("detection runs before any fix or verification call — the mechanical probe gates the model dispatch", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([...detectConflicted, ...fixStaged, out("42 pass\n"), ...commitSequence])
      const stub = stubAgent()
      await runWith(resolveConflicts.run(INPUT), service, stub.service, testRunInfo({ runRoot }))

      expect(calls[0]?.argv).toStrictEqual(["git", "rev-parse", "--verify", "-q", "refs/heads/feat/gh-184-fix"])
      expect(calls[1]?.argv).toStrictEqual(["git", "rev-parse", "--verify", "-q", "refs/heads/main"])
      expect(calls[2]?.argv[1]).toBe("merge-tree")
      expect(calls[3]?.argv).toStrictEqual(["git", "status", "--porcelain"])
    }))
})
