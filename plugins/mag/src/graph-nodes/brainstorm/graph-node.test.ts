import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { BrainstormCommitFailed, BrainstormCopyFailed, BrainstormGitFailed, DesignMissing } from "mag/graph-nodes/brainstorm/errors"
import { brainstorm } from "mag/graph-nodes/brainstorm/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/brainstorm/examples"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { TICKET_TOKEN } from "mag/skills/design/tokens"
import { DESIGN_DESTINATION } from "mag/skills/design/write-and-confirm"
import { removeDir, testRunInfo, withForeignRepo } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!

/** In-order scripted shell, `discover/graph-node.test.ts`'s idiom. */
const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: string[][] = []
  const cwds: Array<string | undefined> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push([...argv])
      cwds.push(options?.cwd)
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, cwds, service }
}

const ok = (): ShellResult => ({ exitCode: 0, stdout: "", stderr: "" })
const HEAD_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
/** `rev-parse HEAD` alone: under the default `run-root` policy, `brainstorm` still reads `headSha`. */
const readsHeadOnly = () => scriptedShell([{ exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" }])
/** `git add` ok, `git diff --cached --quiet` exit 1 (staged), `git commit` ok, `git rev-parse HEAD` ok. */
const commitsCleanly = () => scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, ok(), { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" }])

/** Records the request and answers with a canned reply; `write` fires inside `prompt`, standing in
 * for the real session's own write (`envision-mermaid/graph-node.test.ts`'s idiom). */
const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}, write?: () => void) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      write?.()
      return Effect.succeed({
        verdict: { designPath: "ignored — the node uses its own computed path" } as A,
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

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, shell: ShellService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

/** A disposable repo checkout plus a disposable run root (`design/graph-node.test.ts`'s `withDirs`
 *  shape), every success path now copies into `runRoot` for real (`records.ts`'s `record`). */
const withRepo = async <T>(fn: (repoRoot: string, runRoot: string, run: RunInfoService) => Promise<T>): Promise<T> => {
  const base = mkdtempSync(join(tmpdir(), "brainstorm-"))
  const repoRoot = join(base, "repo")
  const runRoot = join(base, "run")
  mkdirSync(repoRoot, { recursive: true })
  mkdirSync(runRoot, { recursive: true })
  try {
    return await fn(repoRoot, runRoot, testRunInfo({ repoRoot, workRoot: repoRoot, runRoot }))
  } finally {
    await removeDir(base)
  }
}

const designIn = (repoRoot: string): string => join(repoRoot, "docs", "graph", INPUT.ticket, "design.md")

const writeDesign = (repoRoot: string, content = "# Design\n\nSomething.\n"): string => {
  const path = designIn(repoRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe("brainstorm", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(brainstorm.input)) throw new Error("brainstorm.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(brainstorm.input)(example)
    if (!isSchemaHandle(brainstorm.success)) throw new Error("brainstorm.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(brainstorm.success)(example)
  })

  test("the prompt names every vision path, the discover path and the recycle map path, cited, and carries the already-composed brainstorm prompt verbatim", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      await runWith(brainstorm.run(INPUT), agent.service, readsHeadOnly().service, run)

      const request = agent.requests[0]!
      for (const path of INPUT.visionPaths) expect(request.prompt).toContain(path)
      expect(request.prompt).toContain(`- ${INPUT.discoverPath}`)
      expect(request.prompt).toContain(`- ${INPUT.recycleMapPath}`)
      expect(request.prompt).toContain(INPUT.prompt)
    }))

  // The prompt must name the node's own computed destination — the compiled skill's write step
  // only ever carries the relative `DESIGN_DESTINATION`, which resolves against dispatch cwd, not
  // against recordsRoot.
  test("the prompt names the node's own computed design path, overriding the skill's relative destination", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      await runWith(brainstorm.run(INPUT), agent.service, readsHeadOnly().service, run)

      const request = agent.requests[0]!
      expect(request.prompt).toContain(designIn(repoRoot))
    }))

  // The design's own budget check is enforced upstream, at `assemble-brainstorm-prompt`, before
  // any spend. `brainstorm` receives `input.prompt`
  // already composed and already measured — it has no size check of its own to test, and in the
  // graph's own pipeline an oversized composed prompt fails the barrier before `brainstorm.run` is
  // ever reached (`graphs/design-graph/graph.test.ts` proves that edge).

  test("fills <TICKET> and <SKILLS> in the composed prompt it was handed — assemble-brainstorm-prompt's input is {}, so it cannot fill either itself", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      await runWith(
        brainstorm.run({ ...INPUT, prompt: "See <TICKET> at <SKILLS>/brainstorming/reconciliation.md." }),
        agent.service,
        readsHeadOnly().service,
        run
      )

      const request = agent.requests[0]!
      expect(request.prompt).toContain(`See ${INPUT.ticket} at`)
      expect(request.prompt).not.toContain("<TICKET>")
      expect(request.prompt).not.toContain("<SKILLS>")
    }))

  // The compiled skill's own write step is not always this synthetic string — when it IS the real
  // `DESIGN_DESTINATION` literal (every live dispatch, `assemble-brainstorm-prompt`'s actual
  // output), the collapse below must actually fire, not just the override sentence above it. This
  // is what proves the two no longer disagree.
  test("collapses the compiled skill's own DESIGN_DESTINATION onto this run's resolved path, when the prompt it was handed carries it", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const path = designIn(repoRoot)
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      await runWith(
        brainstorm.run({ ...INPUT, prompt: `**Write design doc** — to \`${DESIGN_DESTINATION}\`, then confirm.` }),
        agent.service,
        readsHeadOnly().service,
        run
      )

      const request = agent.requests[0]!
      // The unfilled token never survives — proves the token fill still runs after the collapse.
      expect(request.prompt).not.toContain(TICKET_TOKEN)
      // The resolved absolute path appears twice: the override sentence, and the collapsed write
      // step. Without the collapse this would be 1 — the write step would still read the ticket-
      // filled *relative* literal (`docs/graph/<ticket>/design.md`), a different, shorter string.
      expect(request.prompt.split(path).length - 1).toBe(2)
    }))

  test("a missing design fails DesignMissing, and no git call is made", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent()
      const { calls, service: shell } = scriptedShell([])
      const result = await runWith(brainstorm.run(INPUT), agent.service, shell, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DesignMissing)
      expect((result.failure as DesignMissing).path).toBe(designIn(repoRoot))
      expect(calls).toHaveLength(0)
      expect(existsSync(designIn(repoRoot))).toBe(false)
    }))

  test("a blank design is DesignMissing too", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot, "  \n"))
      const result = await runWith(brainstorm.run(INPUT), agent.service, scriptedShell([]).service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DesignMissing)
    }))

  test("a stale design, unchanged from its pre-dispatch snapshot, is DesignMissing", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      writeDesign(repoRoot)
      const { calls, service: shell } = scriptedShell([])
      const result = await runWith(brainstorm.run(INPUT), stubAgent().service, shell, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DesignMissing)
      expect(calls).toHaveLength(0)
    }))

  test("under the default run-root policy, a written design is copied into the run root, and only rev-parse is called", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const path = designIn(repoRoot)
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      const { calls, service: shell } = readsHeadOnly()

      const result = await runWith(brainstorm.run(INPUT), agent.service, shell, run)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ designPath: path, headSha: HEAD_SHA, sessions: ["stub-session"], costUsd: 0.42 })
      expect(readFileSync(`${runRoot}/design.md`, "utf8")).toBe("# Design\n\nSomething.\n")
      expect(calls).toStrictEqual([["git", "rev-parse", "HEAD"]])
    }))

  test("under records: \"committed\", a written design commits under a pathspec limited to design.md, and headSha comes from rev-parse after the commit", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const path = designIn(repoRoot)
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      const { calls, service: shell } = commitsCleanly()

      const result = await runWith(brainstorm.run(INPUT), agent.service, shell, { ...run, records: "committed" })
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ designPath: path, headSha: HEAD_SHA, sessions: ["stub-session"], costUsd: 0.42 })
      expect(readFileSync(`${runRoot}/design.md`, "utf8")).toBe("# Design\n\nSomething.\n")
      expect(calls[0]).toStrictEqual(["git", "add", "--", path])
      expect(calls[2]).toStrictEqual([
        "git",
        "commit",
        "-m",
        `docs(${INPUT.ticket}): design\n\nThe brainstorm node reconciled the visions with discover's recon and committed the design doc.\n\nClaude-Session: stub-session`,
        "--",
        path
      ])
      expect(calls[3]).toStrictEqual(["git", "rev-parse", "HEAD"])
    }))

  // Under the default `run-root` policy, `recordsRoot` is a plain OS temp directory with no git
  // repository of its own (`run-layers.ts`) — a real `git rev-parse HEAD` there fails `fatal: not a
  // git repository`, three paid sessions in. `headSha` reads at `workRoot` instead, the tree the
  // session actually worked in, meaningful under every policy — and `record`'s commit half never
  // fires under this policy, so no `git add` runs either.
  test("a foreign run under the default run-root policy composes the design under recordsRoot but reads headSha at workRoot, no git add", () =>
    withForeignRepo("brainstorm", async (workRoot, recordsRoot, run) => {
      const path = designIn(recordsRoot)
      const agent = stubAgent({}, () => writeDesign(recordsRoot))
      const { calls, cwds, service: shell } = readsHeadOnly()

      const result = await runWith(brainstorm.run(INPUT), agent.service, shell, run)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.designPath).toBe(path)
      expect(path.startsWith(recordsRoot)).toBe(true)
      expect(path.startsWith(workRoot)).toBe(false)
      expect(readFileSync(`${run.runRoot}/design.md`, "utf8")).toBe("# Design\n\nSomething.\n")

      expect(agent.requests[0]!.cwd).toBe(workRoot)
      expect(calls).toStrictEqual([["git", "rev-parse", "HEAD"]])
      expect(cwds).toStrictEqual([workRoot])
    }))

  test("an empty run root fails BrainstormCopyFailed with 'run root missing', before any prompt", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      const result = await runWith(brainstorm.run(INPUT), agent.service, scriptedShell([]).service, { ...run, runRoot: "" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BrainstormCopyFailed)
      expect((result.failure as BrainstormCopyFailed).detail).toBe("run root missing")
      // The gate sits above the dispatch, so the session is never paid for.
      expect(agent.requests).toHaveLength(0)
    }))

  test("under records: \"committed\", a failed add fails BrainstormGitFailed", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      const failing = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: bad pathspec\n" }])
      const result = await runWith(brainstorm.run(INPUT), agent.service, failing.service, { ...run, records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BrainstormGitFailed)
    }))

  test("under records: \"committed\", a failed commit fails BrainstormCommitFailed, sessions attached", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      const failing = scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, { exitCode: 1, stdout: "", stderr: "fatal: empty ident name\n" }])
      const result = await runWith(brainstorm.run(INPUT), agent.service, failing.service, { ...run, records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BrainstormCommitFailed)
      expect((result.failure as BrainstormCommitFailed).sessions).toStrictEqual(["stub-session"])
    }))

  test("under records: \"committed\", a failed rev-parse after a good commit fails BrainstormGitFailed", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      const failing = scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, ok(), { exitCode: 128, stdout: "", stderr: "fatal: bad revision\n" }])
      const result = await runWith(brainstorm.run(INPUT), agent.service, failing.service, { ...run, records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BrainstormGitFailed)
    }))

  test("under the default run-root policy, a failed rev-parse fails BrainstormGitFailed, the copy itself untouched", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      const failing = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }])
      const result = await runWith(brainstorm.run(INPUT), agent.service, failing.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BrainstormGitFailed)
      expect(readFileSync(`${runRoot}/design.md`, "utf8")).toBe("# Design\n\nSomething.\n")
    }))
})
