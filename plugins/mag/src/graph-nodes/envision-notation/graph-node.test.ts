import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import {
  NotationVisionBlocked,
  NotationVisionCommitFailed,
  NotationVisionCopyFailed,
  NotationVisionGitFailed,
  NotationVisionMissing,
  UnknownNotation
} from "mag/graph-nodes/envision-notation/errors"
import { envisionNotation } from "mag/graph-nodes/envision-notation/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/envision-notation/examples"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { NOTATIONS } from "mag/skills/design/envisioning"
import { BLIND_DRAW_RULE, visionDestination } from "mag/skills/envision/notation"
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
/** `git add` ok, `git diff --cached --quiet` exit 1 (staged), `git commit` ok, the `records: "committed"` shape. */
const commitsCleanly = () => scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, ok()])

/** Records the request and answers with a canned reply; `write` stands in for the session's own
 * write, fired inside `prompt` so it lands between this node's before/after snapshot reads
 * (`envision-mermaid/graph-node.test.ts`'s idiom). */
const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}, write?: () => void) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      write?.()
      return Effect.succeed({
        verdict: { visionPath: "ignored — the node uses its own computed path" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.12,
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

/** A disposable checkout plus a disposable run root (`design/graph-node.test.ts`'s `withDirs` shape),
 *  every success path now copies into `runRoot` for real (`records.ts`'s `record`). */
const withRepo = async <T>(fn: (repoRoot: string, runRoot: string, run: RunInfoService) => Promise<T>): Promise<T> => {
  const base = mkdtempSync(join(tmpdir(), "envision-notation-"))
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

/** The path this node computes, spelled once so a test asserting on it cannot drift from one writing it. */
const visionIn = (repoRoot: string, notation: string): string => join(repoRoot, ...visionDestination(INPUT.ticket, notation).split("/"))

const writeVision = (repoRoot: string, notation: string, content = "graph TD\n  A --> B\n"): string => {
  const path = visionIn(repoRoot, notation)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe("envision-notation", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(envisionNotation.input)) throw new Error("envisionNotation.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(envisionNotation.input)(example)
    if (!isSchemaHandle(envisionNotation.success)) throw new Error("envisionNotation.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(envisionNotation.success)(example)
  })

  test("the prompt carries the ticket, the blind-draw rule, the notation's own destination — and dispatches with no agent/model when none is given", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent()
      await runWith(envisionNotation.run(INPUT), agent.service, scriptedShell([]).service, run)

      expect(agent.requests).toHaveLength(1)
      const request = agent.requests[0]!
      expect(request.cwd).toBe(repoRoot)
      expect(request.agent).toBeUndefined()
      expect(request.model).toBeUndefined()
      expect(request.prompt).toContain(`Ticket ${INPUT.ticket}: ${INPUT.title}`)
      expect(request.prompt).toContain(INPUT.body)
      expect(request.prompt).toContain(BLIND_DRAW_RULE)
      expect(request.prompt).toContain(visionIn(repoRoot, INPUT.notation))
    }))

  test("the input's agent and model reach the dispatch verbatim", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const hardwired = stubAgent()
      await runWith(envisionNotation.run(inputExamples[1]!), hardwired.service, scriptedShell([]).service, run)
      expect(hardwired.requests[0]!.agent).toBe("effect-expert")
      expect(hardwired.requests[0]!.model).toBe("opus")
    }))

  test("an unknown notation fails UnknownNotation, naming it and the known ids, before any dispatch", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const agent = stubAgent()
      const { calls, service: shell } = scriptedShell([])
      const result = await runWith(envisionNotation.run({ ...INPUT, notation: "cobol" }), agent.service, shell, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new UnknownNotation({ notation: "cobol", known: NOTATIONS }))
      expect(agent.requests).toHaveLength(0)
      expect(calls).toHaveLength(0)
    }))

  test("a declared blocked verdict fails NotationVisionBlocked immediately — no disk read past dispatch, no git call, no retry from this node", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const agent = stubAgent({ verdict: { visionPath: "x", blocked: "the ticket names no ideal shape to draw" } })
      const { calls, service: shell } = scriptedShell([])
      const result = await runWith(envisionNotation.run(INPUT), agent.service, shell, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionBlocked)
      const failure = result.failure as NotationVisionBlocked
      expect(failure.notation).toBe(INPUT.notation)
      expect(failure.reason).toBe("the ticket names no ideal shape to draw")
      expect(calls).toHaveLength(0)
    }))

  test("a session that never wrote the vision is NotationVisionMissing, and no git call was made", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent()
      const { calls, service: shell } = scriptedShell([])
      const result = await runWith(envisionNotation.run(INPUT), agent.service, shell, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionMissing)
      const failure = result.failure as NotationVisionMissing
      expect(failure.path).toBe(visionIn(repoRoot, INPUT.notation))
      expect(failure.sessions).toStrictEqual(["stub-session"])
      expect(calls).toHaveLength(0)
      expect(existsSync(visionIn(repoRoot, INPUT.notation))).toBe(false)
    }))

  test("a blank vision is NotationVisionMissing too", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      writeVision(repoRoot, INPUT.notation, "  \n")
      const result = await runWith(envisionNotation.run(INPUT), stubAgent().service, scriptedShell([]).service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionMissing)
    }))

  test("a re-run's stale vision is NotationVisionMissing when the session leaves it untouched", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      writeVision(repoRoot, INPUT.notation)
      const { calls, service: shell } = scriptedShell([])
      const result = await runWith(envisionNotation.run(INPUT), stubAgent().service, shell, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionMissing)
      expect(calls).toHaveLength(0)
    }))

  test("a written vision is copied into the run root under the default policy, no git call, success carries this node's own path even when the verdict echoes a different one", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const path = visionIn(repoRoot, INPUT.notation)
      const agent = stubAgent(
        { verdict: { visionPath: "some/other/path.md" } },
        () => {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, "graph TD\n  A --> B\n")
        }
      )
      const { calls, service: shell } = scriptedShell([])

      const result = await runWith(envisionNotation.run(INPUT), agent.service, shell, run)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        notation: INPUT.notation,
        module: "envision-svelte",
        visionPath: path,
        sessions: ["stub-session"],
        costUsd: 0.12
      })
      expect(readFileSync(`${runRoot}/vision-${INPUT.notation}.md`, "utf8")).toBe("graph TD\n  A --> B\n")
      expect(calls).toHaveLength(0)
    }))

  test("under records: \"committed\", a written vision also commits under a pathspec limited to vision-<notation>.md", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const path = visionIn(repoRoot, INPUT.notation)
      const agent = stubAgent(
        {},
        () => {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, "graph TD\n  A --> B\n")
        }
      )
      const { calls, service: shell } = commitsCleanly()

      const result = await runWith(envisionNotation.run(INPUT), agent.service, shell, { ...run, records: "committed" })
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(calls[0]).toStrictEqual(["git", "add", "--", path])
      expect(calls[2]).toStrictEqual([
        "git",
        "commit",
        "-m",
        `docs(${INPUT.ticket}): vision-${INPUT.notation}\n\nenvision-notation drew the ${INPUT.notation} vision and committed it.\n\nClaude-Session: stub-session`,
        "--",
        path
      ])
    }))

  // The vision's destination follows recordPath/recordsDir. Under the default policy a foreign run's
  // recordsRoot is a disposable temp dir, separate from workRoot where the agent dispatches — under
  // records: "committed" the two are the same tree instead (the "committed" test above already
  // covers that shape).
  test("a foreign run under the default run-root policy composes the vision under recordsRoot, separate from workRoot, and makes no git call", () =>
    withForeignRepo("envision-notation", async (workRoot, recordsRoot, run) => {
      const path = visionIn(recordsRoot, INPUT.notation)
      const agent = stubAgent({}, () => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, "graph TD\n  A --> B\n")
      })
      const { calls, service: shell } = scriptedShell([])

      const result = await runWith(envisionNotation.run(INPUT), agent.service, shell, run)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.visionPath).toBe(path)
      expect(path.startsWith(recordsRoot)).toBe(true)
      expect(path.startsWith(workRoot)).toBe(false)
      expect(readFileSync(`${run.runRoot}/vision-${INPUT.notation}.md`, "utf8")).toBe("graph TD\n  A --> B\n")

      expect(agent.requests[0]!.cwd).toBe(workRoot)
      expect(calls).toHaveLength(0)
    }))

  test("an empty run root fails NotationVisionCopyFailed with 'run root missing', before any prompt", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const path = visionIn(repoRoot, INPUT.notation)
      const agent = stubAgent({}, () => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, "graph TD\n")
      })
      const result = await runWith(envisionNotation.run(INPUT), agent.service, scriptedShell([]).service, { ...run, runRoot: "" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionCopyFailed)
      expect((result.failure as NotationVisionCopyFailed).detail).toBe("run root missing")
      // The gate sits above the dispatch, so the session is never paid for.
      expect(agent.requests).toHaveLength(0)
    }))

  test("under records: \"committed\", a failed add fails NotationVisionGitFailed", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const path = visionIn(repoRoot, INPUT.notation)
      const agent = stubAgent({}, () => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, "graph TD\n")
      })
      const failing = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: bad pathspec\n" }])
      const result = await runWith(envisionNotation.run(INPUT), agent.service, failing.service, { ...run, records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionGitFailed)
    }))

  test("under records: \"committed\", a failed commit fails NotationVisionCommitFailed, sessions attached", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const path = visionIn(repoRoot, INPUT.notation)
      const agent = stubAgent({}, () => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, "graph TD\n")
      })
      const failing = scriptedShell([ok(), { exitCode: 1, stdout: "", stderr: "" }, { exitCode: 1, stdout: "", stderr: "fatal: empty ident name\n" }])
      const result = await runWith(envisionNotation.run(INPUT), agent.service, failing.service, { ...run, records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionCommitFailed)
      expect((result.failure as NotationVisionCommitFailed).sessions).toStrictEqual(["stub-session"])
    }))
})
