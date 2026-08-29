import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { PrBodyDiffWriteFailed, PrBodyGitFailed, PrBodyRunRootMissing } from "mag/graph-nodes/write-pr-body/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/write-pr-body/examples"
import { writePrBody } from "mag/graph-nodes/write-pr-body/graph-node"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo, withRunRoot as withRunRootIn } from "mag/test/node-fixture"

const DIFF = "diff --git a/x.ts b/x.ts\n-old\n+new\n"
const HEAD = "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7"
const DESCRIPTION = "Strips the NUL byte at the artifact writer."

/** Routes by argv: `rev-parse` gets `head`, `git diff <base>...HEAD` gets `diff`. Anything else fails loudly. */
const gitStub = ({ diff = DIFF, head = HEAD }: { diff?: string; head?: string } = {}) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      if (argv[1] === "rev-parse") return Effect.succeed({ exitCode: 0, stdout: `${head}\n`, stderr: "" })
      if (argv[1] === "diff") return Effect.succeed({ exitCode: 0, stdout: diff, stderr: "" })
      throw new Error(`gitStub: unexpected argv ${argv.join(" ")}`)
    }
  }
  return { calls, service }
}

/** `rev-parse` fails outright; nothing downstream is ever reached. */
const failingRevParseShell = (result: ShellResult): ShellService => ({
  run: (argv) => {
    if (argv[1] === "rev-parse") return Effect.succeed(result)
    throw new Error(`failingRevParseShell: unexpected argv ${argv.join(" ")}`)
  }
})

/** `rev-parse` passes, the diff read itself fails. */
const failingDiffShell = (result: ShellResult): ShellService => ({
  run: (argv) => {
    if (argv[1] === "rev-parse") return Effect.succeed({ exitCode: 0, stdout: `${HEAD}\n`, stderr: "" })
    if (argv[1] === "diff") return Effect.succeed(result)
    throw new Error(`failingDiffShell: unexpected argv ${argv.join(" ")}`)
  }
})

const stubAgent = (description: string = DESCRIPTION) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { description } as A,
        result: {},
        sessions: ["write-pr-body-session"],
        costUsd: 0.12,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** Writing the diff and description artifacts needs a real run root. */
const withRunRoot = <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => withRunRootIn("write-pr-body", fn)

const RUN = testRunInfo()
const INPUT = inputExamples[0]!

/**
 * `runPromise`, not `runSync`: `writePrBody` always provides `platform` internally
 * (`graph-node.ts`), and a real `FileSystem` write genuinely suspends the fiber.
 */
const runWith = <A, E>(
  effect: Effect.Effect<A, E, never>,
  shell: ShellService,
  agent: ClaudeAgentService,
  run: RunInfoService = RUN
) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

describe("write-pr-body", () => {
  test("the fixtures decode against write-pr-body's own schemas", () => {
    if (!isSchemaHandle(writePrBody.input)) throw new Error("writePrBody.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(writePrBody.input)(example)
    if (!isSchemaHandle(writePrBody.success)) throw new Error("writePrBody.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(writePrBody.success)(example)
  })

  test("the dispatched prompt names the materialized patch's path and line count, carries the compiled standard's contract-delta heading, and names neither a design path nor a findings path", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub()
      const agent = stubAgent()
      await runWith(writePrBody.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      const request = agent.requests[0]!
      expect(request.prompt).toContain(`${runRoot}/diff-1.patch`)
      // `DIFF` is 3 lines plus a trailing newline; the node's own count strips that newline first.
      expect(request.prompt).toContain("3 lines")
      // The session has no tool allowlist and runs in the tree `push-branch` is about to push; a
      // writing session that leaves an edit behind kills the run.
      expect(request.prompt).toContain("Change nothing.")
      expect(request.prompt).toContain("## Contract delta")
      // Asserted on the wire: nothing reachable from this node's input schema could appear here.
      expect(request.prompt).not.toContain("docs/graph")
      expect(request.prompt).not.toContain("findingsPath")
      expect(request.prompt).not.toContain("designPath")
    }))

  // The prior test above only asserted the prompt's own text, which says nothing about what the diff
  // itself carries — `design` commits `docs/graph/<ticket>/design.md` on this same branch, so an
  // unfiltered `git diff` would include it regardless of prompt wording. This asserts the argv the
  // node actually sends to git excludes that path, which is what keeps the design record's own
  // content out of the patch this node materializes and dispatches.
  test("the diff read itself excludes the design record's directory, not just the prompt's wording", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub()
      const agent = stubAgent()
      await runWith(writePrBody.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      const diffCall = shell.calls.find((call) => call.argv[1] === "diff")!
      expect(diffCall.argv).toStrictEqual(["git", "diff", `${INPUT.base}...HEAD`, "--", ":(exclude)docs/graph/**"])
    }))

  test("the patch file exists on disk, verbatim diff bytes, before the dispatch", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub()
      const agent = stubAgent()
      await runWith(writePrBody.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      expect(readFileSync(`${runRoot}/diff-1.patch`, "utf8")).toBe(DIFF)
    }))

  test("success names the description's run-root file, holding the stub's text verbatim, beside the HEAD the node actually read", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub({ head: HEAD })
      const agent = stubAgent()
      const result = await runWith(writePrBody.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        descriptionPath: `${runRoot}/pr-description-1.md`,
        headSha: HEAD,
        sessions: ["write-pr-body-session"],
        costUsd: 0.12
      })
      expect(readFileSync(result.success.descriptionPath, "utf8")).toBe(DESCRIPTION)
    }))

  test("an empty runRoot is a wiring bug, not a data problem — PrBodyRunRootMissing before any dispatch", async () => {
    const agent = stubAgent()
    const result = await runWith(writePrBody.run(INPUT), gitStub().service, agent.service, testRunInfo({ runRoot: "" }))

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(PrBodyRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  test("a failing rev-parse is PrBodyGitFailed, the agent is never spawned", () =>
    withRunRoot(async (runRoot) => {
      const shell = failingRevParseShell({ exitCode: 128, stdout: "", stderr: "fatal: bad revision\n" })
      const agent = stubAgent()
      const result = await runWith(writePrBody.run(INPUT), shell, agent.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PrBodyGitFailed)
      expect((result.failure as PrBodyGitFailed).exitCode).toBe(128)
      expect(agent.requests).toHaveLength(0)
    }))

  test("a failing diff read is PrBodyGitFailed, the agent is never spawned", () =>
    withRunRoot(async (runRoot) => {
      const shell = failingDiffShell({ exitCode: 128, stdout: "", stderr: "fatal: bad revision 'main...HEAD'\n" })
      const agent = stubAgent()
      const result = await runWith(writePrBody.run(INPUT), shell, agent.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PrBodyGitFailed)
      expect((result.failure as PrBodyGitFailed).exitCode).toBe(128)
      expect(agent.requests).toHaveLength(0)
    }))

  test("an unwritable run root fails the diff write as PrBodyDiffWriteFailed, before any dispatch and before any spend", () =>
    withRunRoot(async (base) => {
      // `review-diff/graph-node.test.ts`'s ENOTDIR trick: a real file sitting where a path
      // component of the run root needs to be a directory, cheaply reproducing the write-failure
      // path without mocking `FileSystem` itself.
      const blocker = join(base, "blocker")
      writeFileSync(blocker, "not a directory")
      const brokenRoot = join(blocker, "subdir")

      const agent = stubAgent()
      const result = await runWith(writePrBody.run(INPUT), gitStub().service, agent.service, testRunInfo({ runRoot: brokenRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(PrBodyDiffWriteFailed)
      const failure = result.failure as PrBodyDiffWriteFailed
      expect(failure.runRoot).toBe(brokenRoot)
      expect(failure.detail.length).toBeGreaterThan(0)
      expect(agent.requests).toHaveLength(0)
    }))

  test("agent and model reach the dispatch verbatim when present, absent when not", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent()
      await runWith(writePrBody.run(INPUT), gitStub().service, bare.service, run)
      expect(bare.requests[0]!.agent).toBeUndefined()
      expect(bare.requests[0]!.model).toBeUndefined()

      const assigned = stubAgent()
      await runWith(writePrBody.run(inputExamples[1]!), gitStub().service, assigned.service, run)
      expect(assigned.requests[0]!.agent).toBe("effect-expert")
      expect(assigned.requests[0]!.model).toBe("sonnet")
    }))
})
