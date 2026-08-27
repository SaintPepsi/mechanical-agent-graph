import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/red-green/examples"
import {
  DeadTestAtBirth,
  PathsTouched,
  RedGreenRunRootMissing,
  RedTestsDoNotCompile,
  StillRed,
  TestDisputed
} from "mag/graph-nodes/red-green/errors"
import { redGreen } from "mag/graph-nodes/red-green/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!
const TYPECHECK = INPUT.typecheckCommand
const TEST = "src/limiter.test.ts"
const STUB = "src/limiter.ts"

const ok = (stdout: string) => Effect.succeed({ exitCode: 0, stdout, stderr: "" })
const exit = (code: number, stderr = "") => Effect.succeed({ exitCode: code, stdout: "", stderr })

/**
 * One stub for every subprocess a loop pass makes, routed by argv shape. `HEAD` walks a fixed sha
 * sequence and advances on every commit, which here means every session (both write-red's and
 * implement's leftovers are committed by their node). The typecheck is answered from `typechecks`
 * and the per-path test command from `colours`, each one entry per call in order, so a test
 * scripts the whole loop by listing what each gate should see. `touched` is what
 * `paths-untouched`'s diff reports.
 */
const loopShell = (options: { colours: readonly number[]; typechecks?: readonly number[]; touched?: string }) => {
  const calls: string[][] = []
  const shas = ["aaa111", "bbb222", "ccc333", "ddd444", "eee555", "fff666"]
  let index = 0
  let asserted = 0
  let typechecked = 0
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const line = argv.join(" ")
      if (line === "git rev-parse HEAD") return ok(`${shas[index]}\n`)
      if (line === "git status --porcelain") {
        // The pre-dispatch gate is always clean; the post-session leftover probe is always dirty.
        const ordinal = calls.filter((call) => call.join(" ") === "git status --porcelain").length
        return ok(ordinal % 2 === 0 ? "?? work\n" : "")
      }
      if (line === "git add -A") return ok("")
      if (line === "git diff --cached --quiet") return exit(1)
      if (argv[0] === "git" && argv[1] === "commit") {
        index += 1
        return ok("")
      }
      // write-red's declaration check: the commit touched exactly the test and the stub.
      if (argv[0] === "git" && argv[1] === "diff" && argv[2] === "--name-only" && argv[4] === "HEAD") return ok(`${STUB}\n${TEST}\n`)
      // paths-untouched's read between two shas.
      if (argv[0] === "git" && argv[1] === "diff" && argv[2] === "--name-only") return ok(options.touched ?? `${STUB}\n`)
      if (line.startsWith("git rev-list --count")) return ok("1\n")
      if (line === `sh -c ${TYPECHECK}`) {
        const code = (options.typechecks ?? [])[typechecked] ?? 0
        typechecked += 1
        return exit(code, code === 0 ? "" : "error TS2304: Cannot find name 'Limiter'.\n")
      }
      if (argv[0] === "sh") {
        const colour = options.colours[asserted]
        asserted += 1
        if (colour === undefined) throw new Error(`loopShell: unscripted assert-red call ${asserted}`)
        return exit(colour)
      }
      throw new Error(`loopShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

const isWritePrompt = (request: ClaudePrint<unknown>) => request.prompt.includes("Write the tests in this plan") || request.prompt.includes("declare only the files you change")
const isImplementPrompt = (request: ClaudePrint<unknown>) => !isWritePrompt(request)

/** Every write pass declares the same test and stub; implement passes answer a summary, or a dispute when scripted. */
const loopAgent = (options: { dispute?: string } = {}) => {
  const requests: Array<ClaudePrint<unknown>> = []
  let writes = 0
  let greens = 0
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      if (isWritePrompt(request as ClaudePrint<unknown>)) {
        writes += 1
        return Effect.succeed({
          verdict: { testPaths: [TEST], stubPaths: [STUB] } as A,
          result: {},
          sessions: [`red-${writes}`],
          costUsd: 0.35,
          attempts: 1
        } as ClaudeReply<A>)
      }
      greens += 1
      return Effect.succeed({
        verdict: { summary: `implement ${greens}`, ...(options.dispute === undefined ? {} : { dispute: options.dispute }) } as A,
        result: {},
        sessions: [`green-${greens}`],
        costUsd: 0.5,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "red-green-"))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

const runLoop = (input: Parameters<typeof redGreen.run>[0], shell: ShellService, agent: ClaudeAgentService, runRoot: string) =>
  Effect.runPromise(
    Effect.result(
      redGreen.run(input).pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, testRunInfo({ runRoot }))
      )
    )
  )

describe("red-green", () => {
  test("the fixtures decode against red-green's own schemas", () => {
    if (!isSchemaHandle(redGreen.input)) throw new Error("redGreen.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(redGreen.input)(example)
    if (!isSchemaHandle(redGreen.success)) throw new Error("redGreen.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(redGreen.success)(example)
  })

  test("the straight line: typecheck green, red at the red sha, green after implement, one pass each, spend folded", () =>
    withRunRoot(async (runRoot) => {
      const agent = loopAgent()
      const shell = loopShell({ colours: [1, 0] })
      const result = await runLoop(INPUT, shell.service, agent.service, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        testPaths: [TEST],
        stubPaths: [STUB],
        redSha: "bbb222",
        headSha: "ccc333",
        commits: 2,
        writePasses: 1,
        implementPasses: 1,
        sessions: ["red-1", "green-1"],
        costUsd: 0.85,
        sessionRef: "green-1"
      })
      // The typecheck runs between write-red's commit and the first per-path run, in workRoot.
      const lines = shell.calls.map((call) => call.join(" "))
      const typecheckAt = lines.indexOf(`sh -c ${TYPECHECK}`)
      const firstAssertAt = lines.findIndex((line) => line.startsWith(`sh -c ${INPUT.testCommand}`))
      expect(typecheckAt).toBeGreaterThan(lines.indexOf("git add -A"))
      expect(firstAssertAt).toBeGreaterThan(typecheckAt)
      // The untouched gate reads exactly the red-to-head range over the declared test paths.
      expect(shell.calls).toContainEqual(["git", "diff", "--name-only", "bbb222", "ccc333"])
      expect(agent.requests.filter(isImplementPrompt)[0]!.resume).toBeUndefined()
    }))

  test("a red commit that does not typecheck routes back to write-red with the report on disk, before any per-path run", () =>
    withRunRoot(async (runRoot) => {
      const agent = loopAgent()
      const shell = loopShell({ colours: [1, 0], typechecks: [2, 0] })
      const result = await runLoop(INPUT, shell.service, agent.service, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.writePasses).toBe(2)
      const writes = agent.requests.filter(isWritePrompt)
      expect(writes).toHaveLength(2)
      const reportPath = join(runRoot, "red-typecheck-1.txt")
      expect(writes[1]!.prompt).toContain(`The tests at bbb222 do not typecheck. Read the report at ${reportPath}`)
      expect(readFileSync(reportPath, "utf8")).toContain("Exit code: 2")
      expect(readFileSync(reportPath, "utf8")).toContain("Cannot find name 'Limiter'")
      // Exactly two per-path runs happened, both on the second (compiling) red commit and after implement.
      expect(shell.calls.filter((call) => call[0] === "sh" && call[2] === INPUT.testCommand)).toHaveLength(2)
    }))

  test("a dead test at birth routes back to write-red with the green paths named, and the second red set proceeds", () =>
    withRunRoot(async (runRoot) => {
      const agent = loopAgent()
      const result = await runLoop(INPUT, loopShell({ colours: [0, 1, 0] }).service, agent.service, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.writePasses).toBe(2)
      expect(result.success.redSha).toBe("ccc333")
      const writes = agent.requests.filter(isWritePrompt)
      expect(writes).toHaveLength(2)
      expect(writes[0]!.prompt).not.toContain("Already green")
      expect(writes[1]!.prompt).toContain(`Already green at bbb222: ${TEST}`)
      expect(writes[1]!.prompt).toContain("declare only the files you change")
    }))

  test("still red after implement resumes the implementing session with the red paths named, then settles", () =>
    withRunRoot(async (runRoot) => {
      const agent = loopAgent()
      const result = await runLoop(INPUT, loopShell({ colours: [1, 1, 0] }).service, agent.service, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.implementPasses).toBe(2)
      expect(result.success.headSha).toBe("ddd444")
      expect(result.success.sessionRef).toBe("green-2")
      const implementsRequests = agent.requests.filter(isImplementPrompt)
      expect(implementsRequests).toHaveLength(2)
      expect(implementsRequests[1]!.resume).toBe("green-1")
      expect(implementsRequests[1]!.prompt).toBe(`Still red at ccc333: ${TEST}. Make them pass by editing source files only, then finish.`)
    }))

  test("the write cap spent refails the last verdict itself: DeadTestAtBirth, RedTestsDoNotCompile", () =>
    withRunRoot(async (runRoot) => {
      const dead = await runLoop({ ...INPUT, cap: 1 }, loopShell({ colours: [0, 0] }).service, loopAgent().service, runRoot)
      expect(Result.isFailure(dead)).toBe(true)
      if (Result.isFailure(dead)) expect(dead.failure).toStrictEqual(new DeadTestAtBirth({ green: [TEST], redSha: "ccc333" }))

      const uncompiled = await runLoop({ ...INPUT, cap: 0 }, loopShell({ colours: [], typechecks: [1] }).service, loopAgent().service, runRoot)
      expect(Result.isFailure(uncompiled)).toBe(true)
      if (!Result.isFailure(uncompiled)) return
      expect(uncompiled.failure).toBeInstanceOf(RedTestsDoNotCompile)
      expect(uncompiled.failure).toMatchObject({ command: TYPECHECK, exitCode: 1, redSha: "bbb222" })
    }))

  test("the implement cap spent refails StillRed with the last head's evidence", () =>
    withRunRoot(async (runRoot) => {
      const agent = loopAgent()
      const result = await runLoop({ ...INPUT, cap: 1 }, loopShell({ colours: [1, 1, 1] }).service, agent.service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new StillRed({ red: [TEST], sha: "ddd444" }))
      expect(agent.requests.filter(isImplementPrompt)).toHaveLength(2)
    }))

  test("an implementation that touched a test file is PathsTouched, and no further pass is dispatched", () =>
    withRunRoot(async (runRoot) => {
      const agent = loopAgent()
      const result = await runLoop(INPUT, loopShell({ colours: [1], touched: `${STUB}\n${TEST}\n` }).service, agent.service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new PathsTouched({ paths: [TEST], fromSha: "bbb222", toSha: "ccc333" }))
      expect(agent.requests).toHaveLength(2)
    }))

  test("a disputed test escapes upward as TestDisputed, uncaught by either loop", () =>
    withRunRoot(async (runRoot) => {
      const result = await runLoop(INPUT, loopShell({ colours: [1] }).service, loopAgent({ dispute: "AC.02 contradicts this test" }).service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestDisputed)
    }))

  test("no run root is RedGreenRunRootMissing before any dispatch", async () => {
    const agent = loopAgent()
    const result = await runLoop(INPUT, loopShell({ colours: [] }).service, agent.service, "")
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(RedGreenRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  test("models route to their own dispatch", () =>
    withRunRoot(async (runRoot) => {
      const agent = loopAgent()
      await runLoop(inputExamples[1]!, loopShell({ colours: [1, 0] }).service, agent.service, runRoot)
      for (const request of agent.requests.filter(isWritePrompt)) expect(request.model).toBe("sonnet")
      for (const request of agent.requests.filter(isImplementPrompt)) expect(request.model).toBe("sonnet")
      for (const request of agent.requests) expect(request.agent).toBe("effect-expert")
    }))
})
