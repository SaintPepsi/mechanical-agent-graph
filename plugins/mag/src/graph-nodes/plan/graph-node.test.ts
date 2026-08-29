import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { PlanCommitFailed, PlanCopyFailed, PlanGitFailed, PlanMissing, PlanResumeEmpty } from "mag/graph-nodes/plan/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/plan/examples"
import { plan } from "mag/graph-nodes/plan/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { compilePlan, PLAN_PARAMS } from "mag/skills/plan"
import { scriptedShell, stubAgent, withForeignRepo, withRecordRepo } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!

const ok = (): ShellResult => ({ exitCode: 0, stdout: "", stderr: "" })
const HEAD_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
const readsHeadOnly = () => scriptedShell([{ exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" }])
const commitsCleanly = () => scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, ok(), { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" }])

/** The verdict echoes a path the node never trusts, the success carries the path the node computed. */
const planAgent = (write?: () => void, reply: Partial<ClaudeReply<unknown>> = {}) =>
  stubAgent({ planPath: "ignored, the node uses its own computed path" }, reply, write)

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, shell: ShellService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

const withRepo = <T>(fn: (repoRoot: string, runRoot: string, run: RunInfoService) => Promise<T>) => withRecordRepo("plan", fn)

const planIn = (repoRoot: string): string => join(repoRoot, "docs", "graph", INPUT.ticket, "plan.md")

const writePlan = (repoRoot: string, content = "# Plan\n\n### Task 1\n"): string => {
  const path = planIn(repoRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe("plan", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(plan.input)) throw new Error("plan.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(plan.input)(example)
    if (!isSchemaHandle(plan.success)) throw new Error("plan.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(plan.success)(example)
  })

  test("the prompt cites the ticket, the design and the recycle map, never the discover note, names its own computed destination, and carries the compiled plan standard", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = planAgent(() => writePlan(repoRoot))
      await runWith(plan.run(INPUT), agent.service, readsHeadOnly().service, run)

      const request = agent.requests[0]!
      expect(request.prompt).toContain(`Read the ticket at \`${INPUT.ticketPath}\`.`)
      expect(request.prompt).toContain(`- ${INPUT.designPath}`)
      expect(request.prompt).not.toContain("discover.md")
      expect(request.prompt).toContain(`- ${INPUT.recycleMapPath}`)
      expect(request.prompt).toContain(`Write the plan to \`${planIn(repoRoot)}\``)
      expect(request.prompt).toContain(compilePlan(PLAN_PARAMS))
    }))

  test("agent and model pass through to the dispatch; absent sends neither", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const bare = planAgent(() => writePlan(repoRoot))
      await runWith(plan.run(INPUT), bare.service, readsHeadOnly().service, run)
      expect(bare.requests[0]!.agent).toBeUndefined()
      expect(bare.requests[0]!.model).toBeUndefined()

      const named = planAgent(() => writePlan(repoRoot, "# Plan\n\nrevised\n"))
      await runWith(plan.run(inputExamples[1]!), named.service, readsHeadOnly().service, run)
      expect(named.requests[0]!.agent).toBe("effect-expert")
      expect(named.requests[0]!.model).toBe("opus")
    }))

  test("a missing plan fails PlanMissing, and no git call is made", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const { calls, service: shell } = scriptedShell([])
      const result = await runWith(plan.run(INPUT), planAgent().service, shell, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanMissing)
      expect((result.failure as PlanMissing).path).toBe(planIn(repoRoot))
      expect(calls).toHaveLength(0)
      expect(existsSync(planIn(repoRoot))).toBe(false)
    }))

  test("a blank plan, and a plan unchanged from its pre-dispatch snapshot, are PlanMissing too", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const blank = await runWith(plan.run(INPUT), planAgent(() => writePlan(repoRoot, "  \n")).service, scriptedShell([]).service, run)
      expect(Result.isFailure(blank) && blank.failure instanceof PlanMissing).toBe(true)

      writePlan(repoRoot)
      const stale = await runWith(plan.run(INPUT), planAgent().service, scriptedShell([]).service, run)
      expect(Result.isFailure(stale) && stale.failure instanceof PlanMissing).toBe(true)
    }))

  test("under the default run-root policy, a written plan is copied into the run root, and only rev-parse is called", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const agent = planAgent(() => writePlan(repoRoot))
      const { calls, service: shell } = readsHeadOnly()

      const result = await runWith(plan.run(INPUT), agent.service, shell, run)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ planPath: planIn(repoRoot), headSha: HEAD_SHA, sessions: ["stub-session"], costUsd: 0.42, sessionRef: "stub-session" })
      expect(readFileSync(`${runRoot}/plan.md`, "utf8")).toBe("# Plan\n\n### Task 1\n")
      expect(calls).toStrictEqual([["git", "rev-parse", "HEAD"]])
    }))

  test("under records: \"committed\", a written plan commits under a pathspec limited to plan.md, and headSha comes from rev-parse after the commit", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const path = planIn(repoRoot)
      const agent = planAgent(() => writePlan(repoRoot))
      const { calls, service: shell } = commitsCleanly()

      const result = await runWith(plan.run(INPUT), agent.service, shell, { ...run, records: "committed" })
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.headSha).toBe(HEAD_SHA)
      expect(readFileSync(`${runRoot}/plan.md`, "utf8")).toBe("# Plan\n\n### Task 1\n")
      expect(calls[0]).toStrictEqual(["git", "add", "--", path])
      expect(calls[2]).toStrictEqual([
        "git",
        "commit",
        "-m",
        `docs(${INPUT.ticket}): plan\n\nThe plan node turned the design into an ordered task list and committed the plan.\n\nClaude-Session: stub-session`,
        "--",
        path
      ])
      expect(calls[3]).toStrictEqual(["git", "rev-parse", "HEAD"])
    }))

  test("a foreign run under the default run-root policy composes the plan under recordsRoot but reads headSha at workRoot, no git add", () =>
    withForeignRepo("plan", async (workRoot, recordsRoot, run) => {
      const path = planIn(recordsRoot)
      const agent = planAgent(() => writePlan(recordsRoot))
      const { calls, cwds, service: shell } = readsHeadOnly()

      const result = await runWith(plan.run(INPUT), agent.service, shell, run)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.planPath).toBe(path)
      expect(path.startsWith(recordsRoot)).toBe(true)
      expect(readFileSync(`${run.runRoot}/plan.md`, "utf8")).toBe("# Plan\n\n### Task 1\n")
      expect(agent.requests[0]!.cwd).toBe(workRoot)
      expect(calls).toStrictEqual([["git", "rev-parse", "HEAD"]])
      expect(cwds).toStrictEqual([workRoot])
    }))

  test("an empty run root fails PlanCopyFailed with 'run root missing', before any prompt", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = planAgent(() => writePlan(repoRoot))
      const result = await runWith(plan.run(INPUT), agent.service, scriptedShell([]).service, { ...run, runRoot: "" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanCopyFailed)
      expect((result.failure as PlanCopyFailed).detail).toBe("run root missing")
      expect(agent.requests).toHaveLength(0)
    }))

  test("under records: \"committed\", a failed add is PlanGitFailed and a failed commit is PlanCommitFailed with sessions attached", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const committed = { ...run, records: "committed" as const }
      const addFails = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: bad pathspec\n" }])
      const added = await runWith(plan.run(INPUT), planAgent(() => writePlan(repoRoot)).service, addFails.service, committed)
      expect(Result.isFailure(added) && added.failure instanceof PlanGitFailed).toBe(true)

      const commitFails = scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, { exitCode: 1, stdout: "", stderr: "fatal: empty ident name\n" }])
      const result = await runWith(plan.run(INPUT), planAgent(() => writePlan(repoRoot, "# Plan\n\nagain\n")).service, commitFails.service, committed)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanCommitFailed)
      expect((result.failure as PlanCommitFailed).sessions).toStrictEqual(["stub-session"])
    }))

  test("a send-back pass resumes the session, keeps the ticket reference, drops the citations and the standard, and asks for the plan-tagged findings", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const sendBack = inputExamples[2]!
      const agent = planAgent(() => writePlan(repoRoot, "# Plan\n\n### Task 1 revised\n"))
      const result = await runWith(plan.run(sendBack), agent.service, readsHeadOnly().service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.sessionRef).toBe("stub-session")
      const request = agent.requests[0]!
      expect(request.resume).toBe("a1b2c3")
      expect(request.prompt).toContain(`Read the ticket at \`${sendBack.ticketPath}\`.`)
      expect(request.prompt).toContain(sendBack.findingsPath!)
      expect(request.prompt).toContain("address every finding tagged `plan:`")
      expect(request.prompt).toContain(`the plan at \`${planIn(repoRoot)}\` in place.`)
      expect(request.prompt).not.toContain("Read the design below")
      expect(request.prompt).not.toContain(compilePlan(PLAN_PARAMS))
    }))

  test("a send-back pass that leaves the plan unchanged is PlanMissing: a plan session has no dispute, it rewrites or it failed", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      writePlan(repoRoot)
      const result = await runWith(plan.run(inputExamples[2]!), planAgent().service, scriptedShell([]).service, run)
      expect(Result.isFailure(result) && result.failure instanceof PlanMissing).toBe(true)
    }))

  test("resume without findingsPath is PlanResumeEmpty, before any dispatch", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const agent = planAgent()
      const result = await runWith(plan.run({ ...INPUT, resume: "a1b2c3" }), agent.service, scriptedShell([]).service, run)
      expect(Result.isFailure(result) && result.failure instanceof PlanResumeEmpty).toBe(true)
      expect(agent.requests).toHaveLength(0)
    }))

  test("under the default run-root policy, a failed rev-parse fails PlanGitFailed, the copy itself untouched", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const failing = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }])
      const result = await runWith(plan.run(INPUT), planAgent(() => writePlan(repoRoot)).service, failing.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanGitFailed)
      expect(readFileSync(`${runRoot}/plan.md`, "utf8")).toBe("# Plan\n\n### Task 1\n")
    }))
})
