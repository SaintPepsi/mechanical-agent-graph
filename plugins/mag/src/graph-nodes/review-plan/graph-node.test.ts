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
const RE_REVIEW = inputExamples[1]!
const ADJUDICATING = inputExamples[2]!

/** The one git read this node makes: `ls-files` for the rulings files, NUL-separated. */
const rulingsShell = (declared = "") => scriptedShell([{ exitCode: 0, stdout: declared, stderr: "" }])

/** A bare string is a design finding, the common case; a plan finding names its target. `disputed` is an adjudicating pass's rulings. */
const reviewAgent = (
  blocking: readonly (string | { readonly target: "design" | "plan"; readonly finding: string })[],
  notes: readonly string[] = [],
  disputed?: readonly { readonly finding: string; readonly upheld: boolean }[]
) =>
  stubAgent(
    {
      blocking: blocking.map((entry) => (typeof entry === "string" ? { target: "design", finding: entry } : entry)),
      notes,
      ...(disputed === undefined ? {} : { disputed })
    },
    { sessions: ["review-session"], costUsd: 0.31 }
  )

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

  test("the input schema has no base, diff or designPath field: the reviewer cannot be handed code or the design", () => {
    if (!isSchemaHandle(reviewPlan.input)) throw new Error("reviewPlan.input is not a Schema")
    const fields = Object.keys(
      Schema.decodeUnknownSync(reviewPlan.input)({ ...INPUT, base: "main", diffPath: "/x.patch", designPath: "/x/design.md" })
    )
    expect(fields).not.toContain("base")
    expect(fields).not.toContain("diffPath")
    expect(fields).not.toContain("designPath")
  })

  test("the prompt names the plan, carries the plan charter, states the four blocking conditions, and the one git read is the rulings ls-files", () =>
    withRunRoot(async (runRoot, run) => {
      const shell = rulingsShell()
      const agent = reviewAgent([])
      await runWith(reviewPlan.run(INPUT), shell.service, agent.service, run)

      expect(shell.calls).toStrictEqual([
        ["git", "ls-files", "-z", "--full-name", "--", ":/CLAUDE.md", ":/*/CLAUDE.md", ":/**/CLAUDE.md", ":/PRINCIPLES.md", ":/*/PRINCIPLES.md"]
      ])
      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(`Ticket ${INPUT.ticket}: ${INPUT.title}`)
      expect(prompt).toContain(`Read the ticket at \`${INPUT.ticketPath}\`.`)
      expect(prompt).toContain(`Review the plan at ${INPUT.planPath}`)
      expect(prompt).toContain("You are an adversarial reviewer. Find where the target fails to meet the ticket.")
      expect(prompt).toContain("The target does not get to define what done means.")
      expect(prompt).toContain("does the plan, built exactly as written, satisfy every acceptance criterion?")
      expect(prompt).toContain("Prior-art hunt:")
      expect(prompt).toContain("Principles audit:")
      expect(prompt).toContain("- notes: everything else")
      expect(prompt).toContain("No questions. Nobody answers one in this run.")
      expect(prompt).toContain("Tag each blocking finding with the artifact that must change")
      expect(prompt).toContain("5. A finding states the defect and its evidence, never a fix or a mechanism")
      expect(prompt).not.toContain("fresh-eyes skim")
      expect(prompt).not.toContain("re-review")
      expect(prompt).toContain("an acceptance criterion no task in the plan proves")
      expect(prompt).toContain("a ruling in the design stated as a choice still open, or with no basis named")
      expect(prompt).not.toContain("Open Questions")
      expect(prompt).toContain("what a rulings file below forbids")
      expect(prompt).not.toContain("recycle map")
      expect(prompt).toContain("Change nothing.")
      expect(prompt).not.toContain("diff")
      expect(prompt).not.toContain("rulings of its own")
      expect(existsSync(`${runRoot}/review-plan-1.md`)).toBe(true)
    }))

  test("a re-review names the prior findings and judges the delta, the fresh hunt framing gone", () =>
    withRunRoot(async (_runRoot, run) => {
      const agent = reviewAgent([])
      await runWith(reviewPlan.run(RE_REVIEW), rulingsShell().service, agent.service, run)

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(`A prior pass raised blocking findings, recorded at ${RE_REVIEW.priorFindingsPath},`)
      expect(prompt).toContain("A finding the first pass did not make is not raised now unless it is blocking.")
      expect(prompt).not.toContain("Find where the target fails to meet the ticket.")
      expect(prompt).not.toContain("This session has no memory of either pass")
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
      expect(readFileSync(`${runRoot}/review-plan-1.md`, "utf8")).toBe(`Reviewed at ${INPUT.headSha}\n\nNo blocking findings.\n\nNotes:\nNone.`)
    }))

  test("notes are recorded in the findings file and never gate: a pass with notes alone still succeeds", () =>
    withRunRoot(async (runRoot, run) => {
      const result = await runWith(reviewPlan.run(INPUT), rulingsShell().service, reviewAgent([], ["plan.md:12 naming drifts from the design"]).service, run)

      expect(Result.isSuccess(result)).toBe(true)
      expect(readFileSync(`${runRoot}/review-plan-1.md`, "utf8")).toBe(
        `Reviewed at ${INPUT.headSha}\n\nNo blocking findings.\n\nNotes:\n- plan.md:12 naming drifts from the design`
      )
    }))

  test("a blocking verdict is PlanBlocked, the findings file written and named on the error, spend aboard", () =>
    withRunRoot(async (runRoot, run) => {
      const result = await runWith(
        reviewPlan.run(INPUT),
        rulingsShell().service,
        reviewAgent([{ target: "plan", finding: "AC.02 has no task" }, "Interpretation Rulings AC.04: no basis named"]).service,
        run
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanBlocked)
      const blocked = result.failure as PlanBlocked
      expect(blocked).toMatchObject({ findingsPath: `${runRoot}/review-plan-1.md`, headSha: INPUT.headSha, sessions: ["review-session"], costUsd: 0.31 })
      // Each finding is rendered under its target, and the targets ride the failure in the same order.
      expect(blocked.targets).toStrictEqual(["plan", "design"])
      expect(readFileSync(blocked.findingsPath, "utf8")).toBe(`Reviewed at ${INPUT.headSha}\n\n- plan: AC.02 has no task\n- design: Interpretation Rulings AC.04: no basis named\n\nNotes:\nNone.`)
    }))

  test("an adjudicating pass names both files in the prompt, and a rejected disputed finding is PlanDisputeRejected carrying disputePath", () =>
    withRunRoot(async (runRoot, run) => {
      const agent = reviewAgent([], [], [{ finding: "AC.02 has no task", upheld: false }])
      const result = await runWith(reviewPlan.run(ADJUDICATING), rulingsShell().service, agent.service, run)

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(ADJUDICATING.findingsPath!)
      expect(prompt).toContain(ADJUDICATING.disputePath!)
      expect(prompt).toContain("This session has no memory of either pass")
      expect(prompt).toContain("Decide each disputed finding in `disputed`")

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanDisputeRejected)
      expect(result.failure).toMatchObject({ findingsPath: `${runRoot}/review-plan-1.md`, disputePath: ADJUDICATING.disputePath, headSha: ADJUDICATING.headSha })
      expect(readFileSync(`${runRoot}/review-plan-1.md`, "utf8")).toBe(
        `Reviewed at ${ADJUDICATING.headSha}\n\nNo blocking findings.\n\nNotes:\nNone.\n\nDispute:\n- rejected: AC.02 has no task`
      )
    }))

  test("an adjudicating pass that upholds the dispute and blocks on another finding is PlanBlocked with that finding's target, the ruling on record", () =>
    withRunRoot(async (runRoot, run) => {
      const agent = reviewAgent([{ target: "plan", finding: "T8 flags its own rule" }], [], [{ finding: "AC.02 has no task", upheld: true }])
      const result = await runWith(reviewPlan.run(ADJUDICATING), rulingsShell().service, agent.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PlanBlocked)
      expect((result.failure as PlanBlocked).targets).toStrictEqual(["plan"])
      expect(readFileSync(`${runRoot}/review-plan-1.md`, "utf8")).toBe(
        `Reviewed at ${ADJUDICATING.headSha}\n\n- plan: T8 flags its own rule\n\nNotes:\nNone.\n\nDispute:\n- upheld: AC.02 has no task`
      )
    }))

  test("an adjudicating pass that upholds the dispute and finds nothing else is an ordinary success", () =>
    withRunRoot(async (_runRoot, run) => {
      const result = await runWith(reviewPlan.run(ADJUDICATING), rulingsShell().service, reviewAgent([], [], [{ finding: "AC.02 has no task", upheld: true }]).service, run)
      expect(Result.isSuccess(result)).toBe(true)
    }))

  test("rulings in an ordinary pass's reply are ignored: no dispute was handed to it, so nothing is rejected and the record shows no dispute section", () =>
    withRunRoot(async (runRoot, run) => {
      const result = await runWith(reviewPlan.run(INPUT), rulingsShell().service, reviewAgent([], [], [{ finding: "unsolicited", upheld: false }]).service, run)
      expect(Result.isSuccess(result)).toBe(true)
      expect(readFileSync(`${runRoot}/review-plan-1.md`, "utf8")).toBe(`Reviewed at ${INPUT.headSha}\n\nNo blocking findings.\n\nNotes:\nNone.`)
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
