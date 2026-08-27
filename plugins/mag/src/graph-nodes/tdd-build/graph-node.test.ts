import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/tdd-build/examples"
import { TddBuildEscapeUnresolved, TestDisputed } from "mag/graph-nodes/tdd-build/errors"
import { tddBuild } from "mag/graph-nodes/tdd-build/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { liveShell, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

/**
 * Git and the per-path test command are scripted; the whole-suite command and every probe reach the
 * real shell over a real tree, because `verify-escapes` only means anything when it runs things.
 * The tree holds `src.txt`, which `write-red` and `implement` "change" only in the script's answers,
 * and which the breakers' claims mutate for real and restore.
 */
const ORIGINAL = "answer=42\nkey=present\n"
const SUITE = "grep -q '^answer=' src.txt"
const TEST = "src.test.ts"
const SRC = "src.txt"

const INPUT = { ...inputExamples[0]!, command: SUITE, typecheckCommand: "true", testCommand: "exit 0", breakers: 1, budget: 2 }

const PLAN = [{ name: "the answer is kept", behaviour: "answer stays 42", bugItCatches: "answer dropped", negativeSpace: [] }]
const SURVIVOR = { path: SRC, find: "42", replace: "43", probeSource: "cat src.txt", rationale: "changes the answer" }
const REFUTED = { ...SURVIVOR, find: "answer=", replace: "broken=", rationale: "breaks the key" }

const ok = (stdout: string) => Effect.succeed({ exitCode: 0, stdout, stderr: "" })
const exit = (code: number) => Effect.succeed({ exitCode: code, stdout: "", stderr: "" })

/**
 * `HEAD` walks a sha sequence and advances on every commit. `assert-red` is answered from
 * `colours` in order (the per-path command is `sh -c "exit 0" sh <path>`, which is told apart from
 * the suite's `sh -c <SUITE>` and a probe's `sh <path>` by its argv); everything else `sh` reaches
 * the real shell in `workRoot`.
 */
const tddShell = (workRoot: string, colours: readonly number[]) => {
  const calls: string[][] = []
  const shas = ["aaa111", "bbb222", "ccc333", "ddd444", "eee555", "fff666", "ggg777"]
  let index = 0
  let asserted = 0
  const service: ShellService = {
    run: (argv, options) => {
      calls.push([...argv])
      const line = argv.join(" ")
      if (line === "git rev-parse HEAD") return ok(`${shas[index]}\n`)
      if (line === "git status --porcelain") {
        const ordinal = calls.filter((call) => call.join(" ") === "git status --porcelain").length
        return ok(ordinal % 2 === 0 ? "?? work\n" : "")
      }
      if (line === "git add -A") return ok("")
      if (line === "git diff --cached --quiet") return exit(1)
      if (argv[0] === "git" && argv[1] === "commit") {
        index += 1
        return ok("")
      }
      if (line === "git diff --name-only main...HEAD") return ok(`${SRC}\n${TEST}\n`)
      if (argv[0] === "git" && argv[1] === "diff" && argv[2] === "--name-only" && argv[4] === "HEAD") return ok(`${SRC}\n${TEST}\n`)
      if (argv[0] === "git" && argv[1] === "diff" && argv[2] === "--name-only") return ok(`${SRC}\n`)
      if (line.startsWith("git rev-list --count")) return ok(`${index}\n`)
      if (argv[0] === "sh" && argv[1] === "-c" && argv[2] === "exit 0") {
        const colour = colours[asserted]
        asserted += 1
        if (colour === undefined) throw new Error(`tddShell: unscripted assert-red call ${asserted}`)
        return exit(colour)
      }
      if (argv[0] === "sh") return liveShell.run(argv, { ...options, cwd: workRoot })
      throw new Error(`tddShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

const isPlan = (request: ClaudePrint<unknown>) => request.prompt.startsWith("Plan the tests")
const isWrite = (request: ClaudePrint<unknown>) => request.prompt.startsWith("Write the tests")
const isBreak = (request: ClaudePrint<unknown>) => request.prompt.startsWith("Break the code")
const isJudge = (request: ClaudePrint<unknown>) => request.prompt.startsWith("Rate the")
const isImplement = (request: ClaudePrint<unknown>) => request.prompt.startsWith("Make the tests")

/** Breakers answer `claimsByRound` in order (a round past the list claims nothing); the judge rates everything one category. */
const tddAgent = (claimsByRound: readonly (readonly unknown[])[], category = "isolation", dispute?: string) => {
  const requests: Array<ClaudePrint<unknown>> = []
  let breaks = 0
  const reply = <A>(verdict: unknown, session: string, costUsd: number) =>
    Effect.succeed({ verdict: verdict as A, result: {}, sessions: [session], costUsd, attempts: 1 } as ClaudeReply<A>)
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      const r = request as ClaudePrint<unknown>
      if (isPlan(r)) return reply<A>({ plan: PLAN }, `plan-${requests.filter(isPlan).length}`, 0.3)
      if (isWrite(r)) return reply<A>({ testPaths: [TEST], stubPaths: [SRC] }, `red-${requests.filter(isWrite).length}`, 0.35)
      if (isBreak(r)) {
        breaks += 1
        return reply<A>({ claims: claimsByRound[breaks - 1] ?? [] }, `break-${breaks}`, 0.4)
      }
      if (isJudge(r)) {
        const count = Number(/Rate the (\d+)/.exec(r.prompt)?.[1] ?? "0")
        return reply<A>({ ratings: Array.from({ length: count }, (_, index) => ({ index, category })) }, "judge", 0.02)
      }
      return reply<A>({ summary: "done", ...(dispute === undefined ? {} : { dispute }) }, `green-${requests.filter(isImplement).length}`, 0.5)
    }
  }
  return { requests, service }
}

const withTree = async <T>(fn: (workRoot: string, runRoot: string) => Promise<T>): Promise<T> => {
  const workRoot = mkdtempSync(join(tmpdir(), "tdd-build-work-"))
  const runRoot = mkdtempSync(join(tmpdir(), "tdd-build-run-"))
  try {
    writeFileSync(join(workRoot, SRC), ORIGINAL)
    writeFileSync(join(workRoot, TEST), "import { expect, test } from \"bun:test\"\ntest(\"kept\", () => {\n  expect(1).toBe(1)\n})\n")
    return await fn(workRoot, runRoot)
  } finally {
    await removeDir(workRoot)
    await removeDir(runRoot)
  }
}

const build = (input: Parameters<typeof tddBuild.run>[0], shell: ShellService, agent: ClaudeAgentService, workRoot: string, runRoot: string) =>
  Effect.runPromise(
    Effect.result(
      tddBuild.run(input).pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, testRunInfo({ workRoot, runRoot }))
      )
    )
  )

describe("tdd-build", () => {
  test("the fixtures decode against tdd-build's own schemas", () => {
    if (!isSchemaHandle(tddBuild.input)) throw new Error("tddBuild.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(tddBuild.input)(example)
    if (!isSchemaHandle(tddBuild.success)) throw new Error("tddBuild.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(tddBuild.success)(example)
  })

  test("one round when nothing severe escapes: plan, red-green, verify, review, summary written, commits counted from the starting head", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = tddAgent([[REFUTED]])
      const shell = tddShell(workRoot, [1, 0])
      const result = await build(INPUT, shell.service, agent.service, workRoot, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      const { costUsd, ...rest } = result.success
      expect(rest).toStrictEqual({
        headSha: "ccc333",
        summaryPath: join(runRoot, "tdd-build-1.md"),
        commits: 2,
        testPaths: [TEST],
        rounds: 1,
        escapes: 0,
        sessions: ["plan-1", "red-1", "green-1", "break-1"],
        sessionRef: "green-1"
      })
      expect(costUsd).toBeCloseTo(1.55)
      expect(readFileSync(result.success.summaryPath, "utf8")).toContain("No verified escapes.")
      // The whole suite ran once over the green head before the review lane, and the breakers saw
      // the source path only, never the declared test.
      expect(shell.calls.filter((call) => call.join(" ") === `sh -c ${SUITE}`).length).toBeGreaterThanOrEqual(1)
      expect(agent.requests.find(isBreak)!.prompt).toContain(`Break the code in ${SRC} without the tests in ${TEST}`)
      expect(readFileSync(join(workRoot, SRC), "utf8")).toBe(ORIGINAL)
    }))

  test("a severe verified escape becomes the next round's only criterion, and the loop settles once nothing severe survives", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = tddAgent([[SURVIVOR], [REFUTED]])
      const result = await build(INPUT, tddShell(workRoot, [1, 0, 1, 0]).service, agent.service, workRoot, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.rounds).toBe(2)
      expect(result.success.headSha).toBe("eee555")
      const plans = agent.requests.filter(isPlan)
      expect(plans).toHaveLength(2)
      expect(plans[0]!.prompt).toContain("- **AC.01 - reset(key) clears only that key**")
      expect(plans[1]!.prompt).toContain("A verified isolation escape: in src.txt, replacing `42` with `43`")
      expect(plans[1]!.prompt).not.toContain("AC.01")
      expect(readFileSync(result.success.summaryPath, "utf8")).toContain("[3] isolation")
    }))

  test("a mild escape (severity below 2) is reported, not routed", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = tddAgent([[SURVIVOR]], "boundary")
      const result = await build(INPUT, tddShell(workRoot, [1, 0]).service, agent.service, workRoot, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.rounds).toBe(1)
      expect(result.success.escapes).toBe(1)
      expect(agent.requests.filter(isPlan)).toHaveLength(1)
    }))

  test("the cap spent with a severe escape still open is TddBuildEscapeUnresolved, carrying it", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = tddAgent([[SURVIVOR], [SURVIVOR]])
      const result = await build({ ...INPUT, cap: 1 }, tddShell(workRoot, [1, 0, 1, 0]).service, agent.service, workRoot, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TddBuildEscapeUnresolved)
      const unresolved = result.failure as TddBuildEscapeUnresolved
      expect(unresolved.rounds).toBe(2)
      expect(unresolved.escape).toStrictEqual({ path: SRC, find: "42", replace: "43", probeSource: "cat src.txt", category: "isolation", severity: 3 })
      expect(agent.requests.filter(isPlan)).toHaveLength(2)
    }))

  test("a disputed test escapes the whole composite as TestDisputed", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = tddAgent([], "isolation", "the criterion contradicts the test")
      const result = await build(INPUT, tddShell(workRoot, [1]).service, agent.service, workRoot, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestDisputed)
    }))

  test("every model routes to its own dispatch", () =>
    withTree(async (workRoot, runRoot) => {
      const agent = tddAgent([[SURVIVOR]], "boundary")
      await build({ ...inputExamples[1]!, command: SUITE, typecheckCommand: "true", testCommand: "exit 0" }, tddShell(workRoot, [1, 0]).service, agent.service, workRoot, runRoot)

      expect(agent.requests.find(isPlan)!.model).toBe("opus")
      expect(agent.requests.find(isWrite)!.model).toBe("sonnet")
      expect(agent.requests.find(isImplement)!.model).toBe("sonnet")
      expect(agent.requests.find(isBreak)!.model).toBe("sonnet")
      expect(agent.requests.find(isJudge)!.model).toBe("haiku")
      for (const request of agent.requests) expect(request.agent).toBe("effect-expert")
    }))
})
