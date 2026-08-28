import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/design-under-review/examples"
import { designUnderReview } from "mag/graph-nodes/design-under-review/graph-node"
import { PlanBlocked, PlanDisputeRejected, PlanReviewGitFailed } from "mag/graph-nodes/review-plan/errors"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellService, shellLayer } from "mag/runtime/shell"
import { withRecordRepo } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!

const isBrainstormPrompt = (request: ClaudePrint<unknown>) =>
  request.prompt.includes("Read each vision below") || request.prompt.includes("A reviewer examined this design")
const isPlanPrompt = (request: ClaudePrint<unknown>) => request.prompt.includes("Read the design below")
const isReviewPrompt = (request: ClaudePrint<unknown>) => request.prompt.includes("Review the design at")

/** Extracts the backticked destination a record-writing node spliced into its own prompt. */
const destinationOf = (prompt: string, marker: string): string => {
  const match = prompt.match(new RegExp(`${marker} \`([^\`]+)\``))
  if (match === null || match[1] === undefined) throw new Error(`no destination for "${marker}" in prompt`)
  return match[1]
}

const writeAt = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * One stub for every dispatch, routed by each node's own prompt text. `reviews` scripts each
 * review pass's findings in order; passes beyond the list come back clean. A brainstorm pass
 * whose index is in `disputing` changes nothing and disputes instead; every other pass rewrites
 * the design with its own pass number, so the record check sees a changed file.
 */
const loopAgent = (reviews: readonly (readonly string[])[] = [], disputing: ReadonlySet<number> = new Set()) => {
  const requests: Array<ClaudePrint<unknown>> = []
  let brainstorms = 0
  let plans = 0
  let reviewsRun = 0
  const reply = <A>(verdict: unknown, session: string, costUsd: number) =>
    Effect.succeed({ verdict: verdict as A, result: {}, sessions: [session], costUsd, attempts: 1 } as ClaudeReply<A>)
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      if (isReviewPrompt(request as ClaudePrint<unknown>)) {
        reviewsRun += 1
        return reply<A>({ blocking: reviews[reviewsRun - 1] ?? [] }, `session-review-plan-${reviewsRun}`, 0.1)
      }
      if (isPlanPrompt(request as ClaudePrint<unknown>)) {
        plans += 1
        writeAt(destinationOf(request.prompt, "Write the plan to"), `# Plan ${plans}\n`)
        return reply<A>({ planPath: "ignored" }, `session-plan-${plans}`, 0.3)
      }
      brainstorms += 1
      if (disputing.has(brainstorms)) {
        return reply<A>({ designPath: "ignored", dispute: "the finding is already answered by the design" }, `session-brainstorm-${brainstorms}`, 0.2)
      }
      const path = request.resume === undefined
        ? destinationOf(request.prompt, "Write the design doc to")
        : destinationOf(request.prompt, "rewrite the design at")
      writeAt(path, `# Design ${brainstorms}\n\n## Interpretation Rulings\n\nNone.\n`)
      return reply<A>({ designPath: "ignored" }, `session-brainstorm-${brainstorms}`, 0.5)
    }
  }
  return { requests, service }
}

/** `rev-parse HEAD` for the two record writers, `ls-files` (no rulings files) for a first brainstorm pass and every review; nothing commits under the default policy. */
const loopShell = (reviewLsFiles: { exitCode: number; stdout: string; stderr: string } = { exitCode: 0, stdout: "", stderr: "" }) => {
  const calls: string[][] = []
  let lsFilesCalls = 0
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      if (argv[1] === "rev-parse") return Effect.succeed({ exitCode: 0, stdout: "abc123\n", stderr: "" })
      // The first `ls-files` is the brainstorm's, before any review; `reviewLsFiles` scripts the
      // reviewer's own, so a failing reply lands on the review step and not on the design pass.
      if (argv[1] === "ls-files") return Effect.succeed(++lsFilesCalls === 1 ? { exitCode: 0, stdout: "", stderr: "" } : reviewLsFiles)
      throw new Error(`loopShell: unexpected argv: ${argv.join(" ")}`)
    }
  }
  return { calls, service }
}

const runNode = (input: Parameters<typeof designUnderReview.run>[0], agent: ClaudeAgentService, shell: ShellService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      designUnderReview.run(input).pipe(
        Effect.provide(shellLayer(shell)),
        Effect.provide(claudeAgentLayer(agent)),
        Effect.provideService(RunInfo, run)
      )
    )
  )

const withRepo = <T>(fn: (repoRoot: string, runRoot: string, run: RunInfoService) => Promise<T>) => withRecordRepo("design-under-review", fn)

describe("design-under-review", () => {
  test("the fixtures decode against the node's own schemas", () => {
    if (!isSchemaHandle(designUnderReview.input)) throw new Error("input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(designUnderReview.input)(example)
    if (!isSchemaHandle(designUnderReview.success)) throw new Error("success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(designUnderReview.success)(example)
  })

  test("a clean first pass: brainstorm, plan, review once, in that order, and fold the pass's whole spend", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const agent = loopAgent()
      const { result } = { result: await runNode(INPUT, agent.service, loopShell().service, run) }

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        designPath: join(repoRoot, "docs", "graph", INPUT.ticket, "design.md"),
        planPath: join(repoRoot, "docs", "graph", INPUT.ticket, "plan.md"),
        headSha: "abc123",
        reviewPasses: 1,
        sessions: ["session-brainstorm-1", "session-plan-1", "session-review-plan-1"],
        costUsd: 0.9
      })
      expect(agent.requests.map((request) => (isBrainstormPrompt(request) ? "brainstorm" : isPlanPrompt(request) ? "plan" : "review"))).toStrictEqual(["brainstorm", "plan", "review"])

      // The plan prompt cites the design the brainstorm wrote; the reviewer is handed both paths
      // and the plan's headSha, never the brainstorm session's output. Every session cites the
      // ticket file and the recycle map by path.
      expect(agent.requests[1]!.prompt).toContain(result.success.designPath)
      expect(agent.requests[2]!.prompt).toContain(result.success.designPath)
      expect(agent.requests[2]!.prompt).toContain(result.success.planPath)
      for (const request of agent.requests) {
        expect(request.prompt).toContain(`Read the ticket at \`${INPUT.ticketPath}\`.`)
        expect(request.prompt).toContain(INPUT.recycleMapPath)
      }
      expect(readFileSync(`${runRoot}/review-plan-1.md`, "utf8")).toBe("Reviewed at abc123\n\nNo blocking findings.")
    }))

  test("a send-back: findings resume the brainstorm session, plan re-runs over the changed design, a fresh review reads both", () =>
    withRepo(async (_repoRoot, runRoot, run) => {
      const agent = loopAgent([["AC.02 has no task"]])
      const result = await runNode(INPUT, agent.service, loopShell().service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toMatchObject({
        reviewPasses: 2,
        costUsd: 0.5 + 0.3 + 0.1 + 0.5 + 0.3 + 0.1,
        // The stub numbers the resumed pass 2; a real resumed session keeps its pinned id.
        sessions: ["session-brainstorm-1", "session-plan-1", "session-review-plan-1", "session-brainstorm-2", "session-plan-2", "session-review-plan-2"]
      })

      const brainstorms = agent.requests.filter(isBrainstormPrompt)
      expect(brainstorms).toHaveLength(2)
      expect(brainstorms[0]!.resume).toBeUndefined()
      expect(brainstorms[1]!.resume).toBe("session-brainstorm-1")
      expect(brainstorms[1]!.prompt).toContain(join(runRoot, "review-plan-1.md"))
      expect(brainstorms[1]!.prompt).not.toContain(INPUT.prompt)
      expect(readFileSync(join(runRoot, "review-plan-1.md"), "utf8")).toBe("Reviewed at abc123\n\n- AC.02 has no task")

      expect(agent.requests.filter(isPlanPrompt)).toHaveLength(2)
      const reviews = agent.requests.filter(isReviewPrompt)
      expect(reviews).toHaveLength(2)
      expect(reviews[1]!.resume).toBeUndefined()
      expect(reviews[1]!.prompt).not.toContain("dispute")
    }))

  test("a cap-spent loop refails the reviewer's own PLAN_BLOCKED, findings still aboard, and dispatches nothing further", () =>
    withRepo(async (_repoRoot, runRoot, run) => {
      const agent = loopAgent([["still open"], ["still open"], ["still open"]])
      const result = await runNode({ ...INPUT, cap: 1 }, agent.service, loopShell().service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanBlocked)
      expect((result.failure as PlanBlocked).findingsPath).toBe(join(runRoot, "review-plan-2.md"))
      expect(agent.requests).toHaveLength(6)
    }))

  test("a disputing send-back changes nothing: plan is not re-run, the adjudicating review reads the dispute, and a clean verdict settles with disputePath", () =>
    withRepo(async (_repoRoot, runRoot, run) => {
      const agent = loopAgent([["AC.02 has no task"]], new Set([2]))
      const result = await runNode(INPUT, agent.service, loopShell().service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toMatchObject({
        reviewPasses: 2,
        disputePath: join(runRoot, "dispute-1.md"),
        sessions: ["session-brainstorm-1", "session-plan-1", "session-review-plan-1", "session-brainstorm-2", "session-review-plan-2"]
      })
      expect(agent.requests.filter(isPlanPrompt)).toHaveLength(1)
      const adjudicating = agent.requests.filter(isReviewPrompt)[1]!
      expect(adjudicating.prompt).toContain(join(runRoot, "review-plan-1.md"))
      expect(adjudicating.prompt).toContain(join(runRoot, "dispute-1.md"))
    }))

  test("an adjudicating pass that still blocks is PlanDisputeRejected, never routed back, whatever the cap", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const agent = loopAgent([["AC.02 has no task"], ["still stands"]], new Set([2]))
      const result = await runNode({ ...INPUT, cap: 5 }, agent.service, loopShell().service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanDisputeRejected)
      expect(agent.requests.filter(isBrainstormPrompt)).toHaveLength(2)
    }))

  test("a non-blocking reviewer error ends the loop at once, unconsumed", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const agent = loopAgent()
      const result = await runNode(INPUT, agent.service, loopShell({ exitCode: 128, stdout: "", stderr: "fatal: bad object\n" }).service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanReviewGitFailed)
      expect(agent.requests).toHaveLength(2)
    }))

  test("agent and model reach every dispatch; absent sends neither", async () => {
    await withRepo(async (_repoRoot, _runRoot, run) => {
      const bare = loopAgent()
      await runNode(INPUT, bare.service, loopShell().service, run)
      expect(bare.requests).toHaveLength(3)
      for (const request of bare.requests) {
        expect(request.agent).toBeUndefined()
        expect(request.model).toBeUndefined()
      }
    })
    await withRepo(async (_repoRoot, _runRoot, run) => {
      const assigned = loopAgent()
      await runNode(inputExamples[1]!, assigned.service, loopShell().service, run)
      expect(assigned.requests).toHaveLength(3)
      for (const request of assigned.requests) {
        expect(request.agent).toBe("effect-expert")
        expect(request.model).toBe("opus")
      }
    })
  })
})
