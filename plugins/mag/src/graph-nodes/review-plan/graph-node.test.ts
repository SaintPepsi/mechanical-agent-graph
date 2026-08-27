import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { Effect, Layer, Result, Schema } from "effect"
import {
  PlanBlocked,
  PlanDisputeIncomplete,
  PlanDisputeRejected,
  PlanReviewGitFailed,
  PlanReviewRunRootMissing
} from "mag/graph-nodes/review-plan/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/review-plan/examples"
import { reviewPlan } from "mag/graph-nodes/review-plan/graph-node"
import { type ClaudeAgentService, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { scriptedShell, stubAgent, testRunInfo, withRunRoot as withNodeRunRoot } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!
const ADJUDICATING = inputExamples[1]!

/** The one git read this node makes: `ls-files` for the rulings files, NUL-separated. */
const rulingsShell = (declared = "") => scriptedShell([{ exitCode: 0, stdout: declared, stderr: "" }])

const reviewAgent = (blocking: readonly string[]) => stubAgent({ blocking }, { sessions: ["review-session"], costUsd: 0.31 })

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, shell: ShellService, agent: ClaudeAgentService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

const withRunRoot = <T>(fn: (runRoot: string, run: RunInfoService) => Promise<T>) => withNodeRunRoot("review-plan", fn)

describe("review-plan", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(reviewPlan.input)) throw new Error("reviewPlan.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(reviewPlan.input)(example)
    if (!isSchemaHandle(reviewPlan.success)) throw new Error("reviewPlan.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(reviewPlan.success)(example)
  })

  test("the input schema has no base and no diff field: the reviewer cannot be handed code", () => {
    if (!isSchemaHandle(reviewPlan.input)) throw new Error("reviewPlan.input is not a Schema")
    const fields = Object.keys(Schema.decodeUnknownSync(reviewPlan.input)({ ...INPUT, base: "main", diffPath: "/x.patch" }))
    expect(fields).not.toContain("base")
    expect(fields).not.toContain("diffPath")
  })

  test("the prompt names the design and the plan, states the four blocking conditions, and the one git read is the rulings ls-files", () =>
    withRunRoot(async (runRoot, run) => {
      const shell = rulingsShell()
      const agent = reviewAgent([])
      await runWith(reviewPlan.run(INPUT), shell.service, agent.service, run)

      expect(shell.calls).toStrictEqual([
        ["git", "ls-files", "-z", "--full-name", "--", ":/CLAUDE.md", ":/*/CLAUDE.md", ":/**/CLAUDE.md", ":/PRINCIPLES.md", ":/*/PRINCIPLES.md"]
      ])
      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(`Ticket ${INPUT.ticket}: ${INPUT.title}`)
      expect(prompt).toContain(INPUT.body)
      expect(prompt).toContain(`Review the design at ${INPUT.designPath} and the plan at ${INPUT.planPath}`)
      expect(prompt).toContain("an acceptance criterion no task in the plan proves")
      expect(prompt).toContain("an entry under the design's Open Questions")
      expect(prompt).toContain("what a rulings file below forbids")
      expect(prompt).toContain("rebuilds what the discover note's reuse map says exists")
      expect(prompt).toContain("Change nothing.")
      expect(prompt).not.toContain("diff")
      expect(prompt).not.toContain("rulings of its own")
      expect(existsSync(`${runRoot}/review-plan-1.md`)).toBe(true)
    }))

  test("every rulings file git returns is listed in the prompt", () =>
    withRunRoot(async (_runRoot, run) => {
      const shell = rulingsShell("CLAUDE.md\0plugins/mag/PRINCIPLES.md\0plugins/mag/src/skills/CLAUDE.md\0")
      const agent = reviewAgent([])
      await runWith(reviewPlan.run(INPUT), shell.service, agent.service, run)

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain("This repository states rulings of its own")
      expect(prompt).toContain("- CLAUDE.md")
      expect(prompt).toContain("- plugins/mag/PRINCIPLES.md")
      expect(prompt).toContain("- plugins/mag/src/skills/CLAUDE.md")
    }))

  test("a clean review succeeds, carrying the reply's sessions and cost, and a passing findings file stamped with the sha", () =>
    withRunRoot(async (runRoot, run) => {
      const result = await runWith(reviewPlan.run(INPUT), rulingsShell().service, reviewAgent([]).service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        findingsPath: `${runRoot}/review-plan-1.md`,
        headSha: INPUT.headSha,
        sessions: ["review-session"],
        costUsd: 0.31
      })
      expect(readFileSync(`${runRoot}/review-plan-1.md`, "utf8")).toBe(`Reviewed at ${INPUT.headSha}\n\nNo blocking findings.`)
    }))

  test("a blocking verdict is PlanBlocked, the findings file written and named on the error, spend aboard", () =>
    withRunRoot(async (runRoot, run) => {
      const result = await runWith(
        reviewPlan.run(INPUT),
        rulingsShell().service,
        reviewAgent(["AC.02 has no task", "Open Questions: which cap?"]).service,
        run
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanBlocked)
      const blocked = result.failure as PlanBlocked
      expect(blocked).toMatchObject({ findingsPath: `${runRoot}/review-plan-1.md`, headSha: INPUT.headSha, sessions: ["review-session"], costUsd: 0.31 })
      expect(readFileSync(blocked.findingsPath, "utf8")).toBe(`Reviewed at ${INPUT.headSha}\n\n- AC.02 has no task\n- Open Questions: which cap?`)
    }))

  test("an adjudicating pass names both files in the prompt, and a blocking verdict is PlanDisputeRejected carrying disputePath", () =>
    withRunRoot(async (runRoot, run) => {
      const agent = reviewAgent(["still stands"])
      const result = await runWith(reviewPlan.run(ADJUDICATING), rulingsShell().service, agent.service, run)

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(ADJUDICATING.findingsPath!)
      expect(prompt).toContain(ADJUDICATING.disputePath!)
      expect(prompt).toContain("This session has no memory of either pass")

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanDisputeRejected)
      expect(result.failure).toMatchObject({ findingsPath: `${runRoot}/review-plan-1.md`, disputePath: ADJUDICATING.disputePath, headSha: ADJUDICATING.headSha })
    }))

  test("an adjudicating pass that passes is an ordinary success", () =>
    withRunRoot(async (_runRoot, run) => {
      const result = await runWith(reviewPlan.run(ADJUDICATING), rulingsShell().service, reviewAgent([]).service, run)
      expect(Result.isSuccess(result)).toBe(true)
    }))

  test("a half-set dispute pair is PlanDisputeIncomplete before any read or dispatch", () =>
    withRunRoot(async (_runRoot, run) => {
      const shell = scriptedShell([])
      const agent = reviewAgent([])
      const result = await runWith(reviewPlan.run({ ...INPUT, disputePath: "/x/dispute-1.md" }), shell.service, agent.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanDisputeIncomplete)
      expect(shell.calls).toHaveLength(0)
      expect(agent.requests).toHaveLength(0)
    }))

  test("an empty run root is PlanReviewRunRootMissing before any dispatch", async () => {
    const agent = reviewAgent([])
    const result = await runWith(reviewPlan.run(INPUT), scriptedShell([]).service, agent.service, testRunInfo({ runRoot: "" }))
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PlanReviewRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  test("ls-files exiting non-zero is PlanReviewGitFailed, the agent never spawned", () =>
    withRunRoot(async (_runRoot, run) => {
      const failing: ShellResult = { exitCode: 128, stdout: "", stderr: "fatal: bad object\n" }
      const agent = reviewAgent([])
      const result = await runWith(reviewPlan.run(INPUT), scriptedShell([failing]).service, agent.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanReviewGitFailed)
      expect(agent.requests).toHaveLength(0)
    }))

  test("agent and model reach the dispatch verbatim; absent sends neither", () =>
    withRunRoot(async (_runRoot, run) => {
      const bare = reviewAgent([])
      await runWith(reviewPlan.run(INPUT), rulingsShell().service, bare.service, run)
      expect(bare.requests[0]!.agent).toBeUndefined()
      expect(bare.requests[0]!.model).toBeUndefined()

      const assigned = reviewAgent([])
      await runWith(reviewPlan.run(ADJUDICATING), rulingsShell().service, assigned.service, run)
      expect(assigned.requests[0]!.agent).toBe("effect-expert")
      expect(assigned.requests[0]!.model).toBe("opus")
    }))

  test("findings files number by pass within one run root", () =>
    withRunRoot(async (runRoot, run) => {
      await runWith(reviewPlan.run(INPUT), rulingsShell().service, reviewAgent(["first"]).service, run)
      const second = await runWith(reviewPlan.run(INPUT), rulingsShell().service, reviewAgent([]).service, run)
      expect(Result.isSuccess(second) && second.success.findingsPath === `${runRoot}/review-plan-2.md`).toBe(true)
    }))
})
