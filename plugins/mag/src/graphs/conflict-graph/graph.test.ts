import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result } from "effect"
import { ConflictRefMissing } from "mag/graph-nodes/detect-conflicts/errors"
import { BaseRefMissing } from "mag/graph-nodes/resolve-base/errors"
import { VerificationFailed } from "mag/graph-nodes/verification/errors"
import { conflictGraph } from "mag/graphs/conflict-graph/graph"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunRootEnv } from "mag/runtime/run-layers"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { RunId } from "mag/runtime/trace/layer"

const RUN_ID = "20260821090000-c0de"
const TICKET = "GH-184"
const BASE = "main"
const TARGET = "feat/gh-184-fix"
const SUITE = "bun run typecheck && bun run test"
const WORKTREE_SETUP = "bun install --frozen-lockfile"

const ok = (stdout: string) => Effect.succeed({ exitCode: 0, stdout, stderr: "" })
const failed = (exitCode: number, stdout = "", stderr = "") => Effect.succeed({ exitCode, stdout, stderr })

/** `f.txt`'s single-file conflict, `conflict-paths.test.ts`'s own probed shape. */
const conflictStdout = ["oid", "f.txt", "", "1", "f.txt"].join("\0") + "\0"

/**
 * One stub for every subprocess the whole run makes, routed by argv line —
 * `graphs/develop-graph/graph.test.ts`'s own idiom. `unmergedCalls` is the one line needing sequencing rather than pure content-routing:
 * `fix-conflicts` reads `git diff --name-only --diff-filter=U -z` twice, before and after the
 * resolver session, and the two calls must answer differently for the mechanical check on
 * whether conflicts were actually resolved to mean anything.
 */
const runShell = (repoRoot: string, workRoot: string, options: { readonly suiteExitCode?: number } = {}) => {
  const calls: string[][] = []
  let unmergedCalls = 0
  const service: ShellService = {
    run: (argv, shellOptions) => {
      calls.push([...argv])
      const line = argv.join(" ")

      // run-layers's own repoRoot discovery, ahead of everything else
      // (`graphs/develop-graph/graph.test.ts`'s own idiom).
      if (line === "git rev-parse --show-toplevel") return ok(`${repoRoot}\n`)

      // run-layers's identity check — one answer for both sides keeps this a home run.
      if (line === "git rev-parse --path-format=absolute --git-common-dir") return ok(`${repoRoot}/.git\n`)

      // resolve-base × 2 (base, then target): both exist locally and on the remote.
      if (line === `git rev-parse --verify -q refs/heads/${BASE}`) return ok("aaa111\n")
      if (line === `git ls-remote --exit-code --heads origin refs/heads/${BASE}`) return ok(`aaa111\trefs/heads/${BASE}\n`)
      if (line === `git rev-parse --verify -q refs/heads/${TARGET}`) return ok("bbb222\n")
      if (line === `git ls-remote --exit-code --heads origin refs/heads/${TARGET}`) return ok(`bbb222\trefs/heads/${TARGET}\n`)

      // worktree-add, then branch adopts the existing target.
      if (line === `git worktree add --detach ${workRoot} ${BASE}`) return ok("")
      if (line === `sh -c ${WORKTREE_SETUP}`) return ok("")
      if (line === `git checkout ${TARGET}`) return ok("")

      // detect-conflicts: target first ("ours"), base second ("theirs").
      if (line === `git merge-tree --write-tree --name-only -z ${TARGET} ${BASE}`) return failed(1, conflictStdout)

      // fix-conflicts: stages and proves the resolution, never commits it.
      if (line === "git status --porcelain") return ok("")
      if (line === `git merge --no-commit --no-ff ${BASE}`) return failed(1)
      if (line === "git diff --name-only --diff-filter=U -z") {
        const reply = unmergedCalls === 0 ? ok("f.txt\0") : ok("")
        unmergedCalls += 1
        return reply
      }
      if (line === "git add -A") return ok("")
      if (line === "git diff --cached --check") return ok("")
      if (line === "git write-tree") return ok("ddd777\n")

      // verification, against fix-conflicts's own staged tree.
      if (line === `sh -c ${SUITE}`) return failed(options.suiteExitCode ?? 0, "42 pass\n")

      // commit-merge: resolve-conflicts's own finishing write, run only once verification is green.
      if (line.startsWith("git commit -m ")) return ok("")
      if (line === "git rev-parse HEAD") return ok("eee555\n")

      // push-branch's own guards, and the push itself.
      if (line === `git rev-list --count ${BASE}..HEAD`) return ok("1\n")
      if (line === `git push -u origin ${TARGET}`) return ok("")

      // worktree-remove
      if (line === `git worktree remove ${workRoot}`) return ok("")

      throw new Error(`runShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

/** Every dispatch is the resolver: a fixed reply is enough, since only `fix-conflicts` ever calls it. */
const runAgent = () => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { summary: "resolved f.txt by keeping both sides' additions" } as A,
        result: {},
        sessions: ["session-resolve-1"],
        costUsd: 0.75,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const withRepo = async <T>(fn: (repoRoot: string, workRoot: string) => Promise<T>): Promise<T> => {
  const temp = mkdtempSync(join(tmpdir(), "conflict-graph-"))
  const repoRoot = join(temp, "repo")
  mkdirSync(repoRoot, { recursive: true })
  const workRoot = `${repoRoot}-worktrees/${TICKET}-${RUN_ID}`
  return fn(repoRoot, workRoot)
}

const runGraph = (
  input: { readonly ticket: string; readonly target: string; readonly base?: string },
  temp: string,
  shell: ShellService,
  agent: ClaudeAgentService
) =>
  Effect.runPromise(
    Effect.result(
      conflictGraph.run(input).pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunId, RUN_ID),
        Effect.provideService(RunRootEnv, { env: { CLAUDE_CONFIG_DIR: temp }, home: "/unused" })
      )
    )
  )

describe("conflict-graph", () => {
  test("wears the GraphNode shape", () => {
    expect(isSchemaHandle(conflictGraph.input)).toBe(true)
    expect(isSchemaHandle(conflictGraph.success)).toBe(true)
    expect(conflictGraph.name).toBe("conflict-graph")
  })

  test("a conflicting pair detects, resolves as merge-conflict-resolver at the graph's declared model, and pushes", () =>
    withRepo(async (repoRoot, workRoot) => {
      const temp = join(repoRoot, "..")
      const { calls, service } = runShell(repoRoot, workRoot)
      const agent = runAgent()
      const result = await runGraph({ ticket: TICKET, target: TARGET }, temp, service, agent.service)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        ticket: TICKET,
        target: TARGET,
        base: BASE,
        conflicts: ["f.txt"],
        resolved: true,
        headSha: "eee555",
        sessions: ["session-resolve-1"],
        costUsd: 0.75,
        pushed: true
      })

      expect(agent.requests).toHaveLength(1)
      expect(agent.requests[0]!.agent).toBe("merge-conflict-resolver")
      expect(agent.requests[0]!.model).toBe("opus")

      expect(calls.map((argv) => argv.join(" "))).toContain(`git push -u origin ${TARGET}`)
      expect(calls.map((argv) => argv.join(" "))).toContain(`git worktree remove ${workRoot}`)
    }))

  test("a clean pair spends nothing and never pushes", () =>
    withRepo(async (repoRoot, workRoot) => {
      const temp = join(repoRoot, "..")
      const { calls, service } = runShell(repoRoot, workRoot)
      // Override detect-conflicts's own merge-tree route to a clean exit for this one test.
      const clean: ShellService = {
        run: (argv, options) => {
          const line = argv.join(" ")
          if (line === `git merge-tree --write-tree --name-only -z ${TARGET} ${BASE}`) {
            calls.push([...argv])
            return Effect.succeed({ exitCode: 0, stdout: "ccc333\n", stderr: "" })
          }
          return service.run(argv, options)
        }
      }
      const agent = runAgent()
      const result = await runGraph({ ticket: TICKET, target: TARGET }, temp, clean, agent.service)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.resolved).toBe(false)
      expect(result.success.pushed).toBe(false)
      expect(agent.requests).toHaveLength(0)
      expect(calls.map((argv) => argv.join(" "))).not.toContain(`git push -u origin ${TARGET}`)
      expect(calls.map((argv) => argv.join(" "))).not.toContain(`sh -c ${SUITE}`)
    }))

  test("an unresolvable base fails before any worktree or agent spend", () =>
    withRepo(async (repoRoot, workRoot) => {
      const temp = join(repoRoot, "..")
      const { calls, service } = runShell(repoRoot, workRoot)
      const missingBase: ShellService = {
        run: (argv, options) => {
          const line = argv.join(" ")
          if (line === `git rev-parse --verify -q refs/heads/${BASE}`) {
            calls.push([...argv])
            return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
          }
          return service.run(argv, options)
        }
      }
      const agent = runAgent()
      const result = await runGraph({ ticket: TICKET, target: TARGET }, temp, missingBase, agent.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new BaseRefMissing({ base: BASE }))
      expect(agent.requests).toHaveLength(0)
      expect(calls.map((argv) => argv.join(" "))).not.toContain(`git worktree add --detach ${workRoot} ${BASE}`)
    }))

  test("an unresolvable target fails ConflictRefMissing before any worktree spend — detect-conflicts is the gate, not a second resolve-base call", () =>
    withRepo(async (repoRoot, workRoot) => {
      const temp = join(repoRoot, "..")
      const { calls, service } = runShell(repoRoot, workRoot)
      const missingTarget: ShellService = {
        run: (argv, options) => {
          const line = argv.join(" ")
          if (line === `git rev-parse --verify -q refs/heads/${TARGET}`) {
            calls.push([...argv])
            return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
          }
          return service.run(argv, options)
        }
      }
      const agent = runAgent()
      const result = await runGraph({ ticket: TICKET, target: TARGET }, temp, missingTarget, agent.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new ConflictRefMissing({ ref: TARGET }))
      expect(agent.requests).toHaveLength(0)
      expect(calls.map((argv) => argv.join(" "))).not.toContain(`git worktree add --detach ${workRoot} ${BASE}`)
    }))

  test("a target that exists only locally still resolves: detect-conflicts never checks the remote for it", () =>
    withRepo(async (repoRoot, workRoot) => {
      const temp = join(repoRoot, "..")
      const { service } = runShell(repoRoot, workRoot)
      const noRemoteCheckOnTarget: ShellService = {
        run: (argv, options) => {
          const line = argv.join(" ")
          if (line === `git ls-remote --exit-code --heads origin refs/heads/${TARGET}`) {
            throw new Error(`unexpected remote check for target: ${line}`)
          }
          return service.run(argv, options)
        }
      }
      const agent = runAgent()
      const result = await runGraph({ ticket: TICKET, target: TARGET }, temp, noRemoteCheckOnTarget, agent.service)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.resolved).toBe(true)
    }))

  test("a red verification fails the run and push never appears in the call log", () =>
    withRepo(async (repoRoot, workRoot) => {
      const temp = join(repoRoot, "..")
      const { calls, service } = runShell(repoRoot, workRoot, { suiteExitCode: 1 })
      const agent = runAgent()
      const result = await runGraph({ ticket: TICKET, target: TARGET }, temp, service, agent.service)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VerificationFailed)
      expect(calls.map((argv) => argv.join(" "))).not.toContain(`git push -u origin ${TARGET}`)
      expect(calls.map((argv) => argv.join(" "))).not.toContain(`git worktree remove ${workRoot}`)
    }))
})
