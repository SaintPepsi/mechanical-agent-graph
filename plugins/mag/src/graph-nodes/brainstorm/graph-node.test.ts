import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { BrainstormCommitFailed, BrainstormCopyFailed, BrainstormGitFailed, BrainstormResumeEmpty, DesignMissing } from "mag/graph-nodes/brainstorm/errors"
import { brainstorm } from "mag/graph-nodes/brainstorm/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/brainstorm/examples"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { TICKET_TOKEN } from "mag/skills/design/tokens"
import { DESIGN_DESTINATION } from "mag/skills/design/write-and-confirm"
import { scriptedShell, stubAgent as recordAgent, withForeignRepo, withRecordRepo } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!

const ok = (): ShellResult => ({ exitCode: 0, stdout: "", stderr: "" })
const HEAD_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
/** `rev-parse HEAD` alone: under the default `run-root` policy, `brainstorm` still reads `headSha`. */
const readsHeadOnly = () => scriptedShell([{ exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" }])
/** `git add` ok, `git diff --cached --quiet` exit 1 (staged), `git commit` ok, `git rev-parse HEAD` ok. */
const commitsCleanly = () => scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, ok(), { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" }])

/** The verdict echoes a path the node never trusts — the success carries the path the node computed. */
const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}, write?: () => void) =>
  recordAgent({ designPath: "ignored — the node uses its own computed path" }, reply, write)

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, shell: ShellService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

const withRepo = <T>(fn: (repoRoot: string, runRoot: string, run: RunInfoService) => Promise<T>) => withRecordRepo("brainstorm", fn)

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

  test("the prompt names every vision path and the discover path, cited, and carries the already-composed brainstorm prompt verbatim", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeDesign(repoRoot))
      await runWith(brainstorm.run(INPUT), agent.service, readsHeadOnly().service, run)

      const request = agent.requests[0]!
      for (const path of INPUT.visionPaths) expect(request.prompt).toContain(path)
      expect(request.prompt).toContain(INPUT.discoverPath)
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
      expect(result.success).toStrictEqual({ designPath: path, headSha: HEAD_SHA, sessions: ["stub-session"], costUsd: 0.42, sessionRef: "stub-session", changed: true })
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
      expect(result.success).toStrictEqual({ designPath: path, headSha: HEAD_SHA, sessions: ["stub-session"], costUsd: 0.42, sessionRef: "stub-session", changed: true })
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

  test("a send-back pass resumes the session, drops the ticket framing and the compiled skill, and names the findings file", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const sendBack = inputExamples[2]!
      const agent = stubAgent({}, () => writeDesign(repoRoot, "# Design\n\nrevised\n"))
      const result = await runWith(brainstorm.run(sendBack), agent.service, readsHeadOnly().service, run)

      expect(Result.isSuccess(result)).toBe(true)
      const request = agent.requests[0]!
      expect(request.resume).toBe("a1b2c3")
      expect(request.prompt).toContain(sendBack.findingsPath!)
      expect(request.prompt).toContain(`rewrite the design at \`${designIn(repoRoot)}\``)
      expect(request.prompt).not.toContain(sendBack.body)
      expect(request.prompt).not.toContain(sendBack.prompt)
      expect(request.prompt).not.toContain("Read each vision below")
    }))

  test("a send-back pass with an unchanged design and a dispute succeeds, files dispute-N.md, and carries both paths; no record is re-copied", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      writeDesign(repoRoot)
      const sendBack = inputExamples[2]!
      const agent = stubAgent({ verdict: { designPath: "ignored", dispute: "AC.02 is proved by task 3 already" } })
      const { calls, service: shell } = readsHeadOnly()
      const result = await runWith(brainstorm.run(sendBack), agent.service, shell, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toMatchObject({ findingsPath: sendBack.findingsPath, disputePath: `${runRoot}/dispute-1.md`, sessionRef: "stub-session" })
      expect(readFileSync(`${runRoot}/dispute-1.md`, "utf8")).toBe(`Disputes ${sendBack.findingsPath}\n\nAC.02 is proved by task 3 already`)
      expect(existsSync(`${runRoot}/design.md`)).toBe(false)
      expect(calls).toStrictEqual([["git", "rev-parse", "HEAD"]])
    }))

  test("a send-back pass with an unchanged design and no dispute is DesignMissing, as any silent pass", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      writeDesign(repoRoot)
      const result = await runWith(brainstorm.run(inputExamples[2]!), stubAgent().service, scriptedShell([]).service, run)
      expect(Result.isFailure(result) && result.failure instanceof DesignMissing).toBe(true)
    }))

  test("a send-back pass that changes the design and disputes too records the design and files the dispute", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      writeDesign(repoRoot)
      const agent = stubAgent({ verdict: { designPath: "ignored", dispute: "finding 2 is wrong" } }, () => writeDesign(repoRoot, "# Design\n\nrevised\n"))
      const result = await runWith(brainstorm.run(inputExamples[2]!), agent.service, readsHeadOnly().service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.disputePath).toBe(`${runRoot}/dispute-1.md`)
      expect(readFileSync(`${runRoot}/design.md`, "utf8")).toBe("# Design\n\nrevised\n")
    }))

  test("a first pass ignores a dispute in the reply: no findings to answer, so no dispute file", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const agent = stubAgent({ verdict: { designPath: "ignored", dispute: "nothing to dispute" } }, () => writeDesign(repoRoot))
      const result = await runWith(brainstorm.run(INPUT), agent.service, readsHeadOnly().service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.disputePath).toBeUndefined()
      expect(existsSync(`${runRoot}/dispute-1.md`)).toBe(false)
    }))

  test("resume without findingsPath is BrainstormResumeEmpty, before any dispatch", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const agent = stubAgent()
      const result = await runWith(brainstorm.run({ ...INPUT, resume: "a1b2c3" }), agent.service, scriptedShell([]).service, run)
      expect(Result.isFailure(result) && result.failure instanceof BrainstormResumeEmpty).toBe(true)
      expect(agent.requests).toHaveLength(0)
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
