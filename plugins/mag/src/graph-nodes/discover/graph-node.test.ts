import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { DiscoverCommitFailed, DiscoverCopyFailed, DiscoverNoteMissing } from "mag/graph-nodes/discover/errors"
import { discover } from "mag/graph-nodes/discover/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/discover/examples"
import { UsageLimit } from "mag/runtime/claude/errors"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { compileRecon, RECON_PARAMS } from "mag/skills/recon"
import { removeDir, testRunInfo, withForeignRepo } from "mag/test/node-fixture"

/** In-order scripted shell, `simplify/graph-node.test.ts`'s idiom. */
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

const out = (): ShellResult => ({ exitCode: 0, stdout: "", stderr: "" })
/** `git diff --cached --quiet`: exit 0 means nothing staged (already matches HEAD), exit 1 means it doesn't. */
const diffCached = (hasStaged: boolean): ShellResult => ({ exitCode: hasStaged ? 1 : 0, stdout: "", stderr: "" })
/** `git add` ok, `git diff --cached --quiet` exit 1 (staged), `git commit` ok, the `records: "committed"` shape. */
const commitsCleanly = () => scriptedShell([out(), diffCached(true), out()])

/**
 * A stub agent that records the request and answers with a canned reply; it does not touch disk,
 * a test that needs the note on disk writes it itself, standing in for the real session's own write
 * (the agent owns the artifact).
 */
/** `onPrompt` stands in for the session's own write: the node snapshots the note before dispatch and
 * refuses one identical to it, so a test's note must land during the prompt, never before it. */
const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}, onPrompt: () => void = () => {}) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      onPrompt()
      return Effect.succeed({
        verdict: { discoverPath: "docs/graph/GH-258/discover.md" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.18,
        attempts: 1,
        ...reply
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const RUN = testRunInfo()
const INPUT = inputExamples[0]!

const runWith = <A, E>(
  effect: Effect.Effect<A, E, never>,
  agent: ClaudeAgentService,
  shell: ShellService,
  run = RUN
) =>
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
  const base = mkdtempSync(join(tmpdir(), "discover-node-"))
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

/** The path the node computes for the note, spelled once so a test asserting on it cannot drift from one writing it. */
const noteIn = (repoRoot: string): string => join(repoRoot, "docs", "graph", INPUT.ticket, "discover.md")

/** Stands in for the agent session's own write of the note. */
const writeNote = (repoRoot: string, content = "Reuse map: `foo.ts:1` already covers this."): string => {
  const path = noteIn(repoRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe("discover", () => {
  test("the fixtures decode against discover's own schemas", () => {
    if (!isSchemaHandle(discover.input)) throw new Error("discover.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(discover.input)(example)
    if (!isSchemaHandle(discover.success)) throw new Error("discover.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(discover.success)(example)
  })

  // The prompt carries the ticket alone, never a vision or design field, there is none in the
  // input schema to carry, so this checks the bytes the dispatch actually received.
  test("the prompt carries the ticket, body, computed destination, and the compiled standard — no vision or design text", async () => {
    const agent = stubAgent()
    // RUN's repoRoot is a fake path, so the post-session file check fails cleanly after dispatch,
    // this test only cares about what was sent.
    await runWith(discover.run(INPUT), agent.service, scriptedShell([]).service)

    expect(agent.requests).toHaveLength(1)
    const request = agent.requests[0]!
    expect(request.cwd).toBe("/repo")
    expect(request.prompt).toContain(`Ticket ${INPUT.ticket}: ${INPUT.title}`)
    expect(request.prompt).toContain(INPUT.body)
    expect(request.prompt).toContain("Read only.")
    expect(request.prompt).toContain(`docs/graph/${INPUT.ticket}/discover.md`)
    expect(request.prompt).toContain(compileRecon(RECON_PARAMS))
    expect(request.prompt).not.toContain("vision")
    expect(request.prompt).not.toContain("design.md")
  })

  test("the input's agent reaches the dispatch verbatim; without one, none is sent", async () => {
    const bare = stubAgent()
    await runWith(discover.run(INPUT), bare.service, scriptedShell([]).service)
    expect(bare.requests[0]!.agent).toBeUndefined()

    const hardwired = stubAgent()
    await runWith(discover.run(inputExamples[1]!), hardwired.service, scriptedShell([]).service)
    expect(hardwired.requests[0]!.agent).toBe("effect-expert")
  })

  test("the input's model reaches the dispatch verbatim; without one, none is sent", async () => {
    const bare = stubAgent()
    await runWith(discover.run(INPUT), bare.service, scriptedShell([]).service)
    expect(bare.requests[0]!.model).toBeUndefined()

    const assigned = stubAgent()
    await runWith(discover.run(inputExamples[1]!), assigned.service, scriptedShell([]).service)
    expect(assigned.requests[0]!.model).toBe("opus")
  })

  // Default policy (`RunInfoService.records === "run-root"`): the success carries the computed
  // path, the note is copied into the run root, and no git call is made at all.
  test("a written note is copied into the run root, success carries the computed path, no git call under the default policy", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const notePath = noteIn(repoRoot)
      const agent = stubAgent({}, () => writeNote(repoRoot))
      const { calls, service } = scriptedShell([])
      const result = await runWith(discover.run(INPUT), agent.service, service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ discoverPath: notePath, sessions: ["stub-session"], costUsd: 0.18 })
      expect(readFileSync(`${runRoot}/discover.md`, "utf8")).toBe("Reuse map: `foo.ts:1` already covers this.")
      expect(calls).toHaveLength(0)
    }))

  // `records: "committed"`: the same copy, plus a pathspec-scoped add/commit of the repo path.
  test("under records: \"committed\", a written note is also committed with a pathspec-scoped add and commit", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const notePath = noteIn(repoRoot)
      const agent = stubAgent({}, () => writeNote(repoRoot))
      const { calls, service } = commitsCleanly()
      const result = await runWith(discover.run(INPUT), agent.service, service, { ...run, records: "committed" })

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ discoverPath: notePath, sessions: ["stub-session"], costUsd: 0.18 })
      expect(readFileSync(`${runRoot}/discover.md`, "utf8")).toBe("Reuse map: `foo.ts:1` already covers this.")

      expect(calls).toHaveLength(3)
      expect(calls[0]).toStrictEqual(["git", "add", "--", notePath])
      expect(calls[1]).toStrictEqual(["git", "diff", "--cached", "--quiet", "--", notePath])
      expect(calls[2]![0]).toBe("git")
      expect(calls[2]![1]).toBe("commit")
      expect(calls[2]!.at(-1)).toBe(notePath)
      expect(calls[2]).toContain("--")
    }))

  // The placement decision is run-layers.ts's, read back here through recordPath/recordsDir. Under
  // the default policy a foreign run's recordsRoot is a disposable temp dir, separate from workRoot
  // where the agent dispatches — under records: "committed" the two are the same tree instead
  // (`discover`'s "committed" test above already covers that shape).
  test("a foreign run under the default run-root policy copies the note into recordsRoot, separate from workRoot, and makes no git call", () =>
    withForeignRepo("discover-node", async (workRoot, recordsRoot, run) => {
      const notePath = noteIn(recordsRoot)
      const agent = stubAgent({}, () => writeNote(recordsRoot))
      const { calls, service } = scriptedShell([])
      const result = await runWith(discover.run(INPUT), agent.service, service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.discoverPath).toBe(notePath)
      expect(notePath.startsWith(recordsRoot)).toBe(true)
      expect(notePath.startsWith(workRoot)).toBe(false)
      expect(readFileSync(`${run.runRoot}/discover.md`, "utf8")).toBe("Reuse map: `foo.ts:1` already covers this.")

      expect(agent.requests).toHaveLength(1)
      expect(agent.requests[0]!.cwd).toBe(workRoot)
      expect(calls).toHaveLength(0)
    }))

  test("under records: \"committed\", the commit carries the ticket and one Claude-Session trailer per session", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({ sessions: ["s1", "s2"] }, () => writeNote(repoRoot))
      const { calls, service } = commitsCleanly()
      const result = await runWith(discover.run(INPUT), agent.service, service, { ...run, records: "committed" })

      expect(Result.isSuccess(result)).toBe(true)
      const message = calls[2]![3]!
      expect(message).toContain(INPUT.ticket)
      expect(message).toContain("Claude-Session: s1")
      expect(message).toContain("Claude-Session: s2")
    }))

  // Error Handling table's last row: the staged check finds nothing, the node returns success with
  // no commit call at all, asserting the absence is the claim, not just a green success.
  test("under records: \"committed\", a note already committed by the session returns success with no commit call", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const notePath = noteIn(repoRoot)
      const agent = stubAgent({}, () => writeNote(repoRoot))
      const { calls, service } = scriptedShell([out(), diffCached(false)])
      const result = await runWith(discover.run(INPUT), agent.service, service, { ...run, records: "committed" })

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.discoverPath).toBe(notePath)
      expect(calls).toHaveLength(2)
      for (const call of calls) expect(call).not.toContain("commit")
    }))

  // A session that never wrote the file is DiscoverNoteMissing, carrying the path and the sessions
  // spent, and no `git` call was made, never trusting the session's own claim.
  test("a session that never wrote the note is DiscoverNoteMissing, and no git call was made", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent()
      const { calls, service } = scriptedShell([])
      const result = await runWith(discover.run(INPUT), agent.service, service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DiscoverNoteMissing)
      const failure = result.failure as DiscoverNoteMissing
      expect(failure.path).toBe(noteIn(repoRoot))
      expect(failure.sessions).toStrictEqual(["stub-session"])
      expect(calls).toHaveLength(0)
      expect(existsSync(noteIn(repoRoot))).toBe(false)
    }))

  test("a blank note is DiscoverNoteMissing too — whitespace is not a finding", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeNote(repoRoot, "  \n"))
      const result = await runWith(discover.run(INPUT), agent.service, scriptedShell([]).service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DiscoverNoteMissing)
    }))

  test("a note left by a previous run, untouched by this session, is DiscoverNoteMissing", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      // The note is written before the dispatch, never during it, so it becomes the node's own
      // pre-dispatch snapshot: `record` (`records.ts`) reads a file identical to `before` as
      // "the session declared success but produced nothing new" and fails the same as a missing
      // one. Dropping the `written === before` disjunct turns this into a false success.
      writeNote(repoRoot)
      const agent = stubAgent()
      const { calls, service } = scriptedShell([])
      const result = await runWith(discover.run(INPUT), agent.service, service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DiscoverNoteMissing)
      expect((result.failure as DiscoverNoteMissing).path).toBe(noteIn(repoRoot))
      // Never reaches the copy or the commit: no stale note lands in the run root either.
      expect(existsSync(`${runRoot}/discover.md`)).toBe(false)
      expect(calls).toHaveLength(0)
    }))

  test("an empty run root fails DiscoverCopyFailed with 'run root missing', before any prompt or git call", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeNote(repoRoot))
      const { calls, service } = commitsCleanly()
      const result = await runWith(discover.run(INPUT), agent.service, service, { ...run, runRoot: "", records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DiscoverCopyFailed)
      expect((result.failure as DiscoverCopyFailed).detail).toBe("run root missing")
      // The gate sits above the dispatch, so the session is never paid for.
      expect(agent.requests).toHaveLength(0)
      expect(calls).toHaveLength(0)
    }))

  test("under records: \"committed\", a failing add is DiscoverCommitFailed, carrying the argv and exit code", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeNote(repoRoot))
      const failing = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: bad pathspec\n" }])
      const result = await runWith(discover.run(INPUT), agent.service, failing.service, { ...run, records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DiscoverCommitFailed)
      const failure = result.failure as DiscoverCommitFailed
      expect(failure.exitCode).toBe(128)
      expect(failure.argv).toContain("git add")
      expect(failure.sessions).toStrictEqual(["stub-session"])
    }))

  test("under records: \"committed\", a failing commit is DiscoverCommitFailed, after a successful scoped add", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeNote(repoRoot))
      const failing = scriptedShell([out(), diffCached(true), { exitCode: 1, stdout: "", stderr: "fatal: nope\n" }])
      const result = await runWith(discover.run(INPUT), agent.service, failing.service, { ...run, records: "committed" })

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DiscoverCommitFailed)
      const failure = result.failure as DiscoverCommitFailed
      expect(failure.exitCode).toBe(1)
      expect(failure.argv).toContain("git commit")
    }))

  // The compiled standard opens with the reuse map and carries the empty-search rule, a
  // pure-function assertion, no dispatch.
  test("the compiled standard opens with the reuse map and carries the empty-search rule", () => {
    const compiled = compileRecon(RECON_PARAMS)
    expect(compiled.indexOf("Reuse map")).toBeGreaterThanOrEqual(0)
    expect(compiled.indexOf("Reuse map")).toBeLessThan(compiled.indexOf("Relevant files"))
    expect(compiled).toContain("names the searches that came up empty")
  })

  // The standard names no generated index, and every committed-policy git call names the note
  // itself, never a bare directory.
  test("the standard names no generated index, and every committed-policy git call names the note itself, never a bare directory", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const compiled = compileRecon(RECON_PARAMS)
      expect(compiled).toContain("Read no generated index and write none")

      const agent = stubAgent({}, () => writeNote(repoRoot))
      const { calls, service } = commitsCleanly()
      await runWith(discover.run(INPUT), agent.service, service, { ...run, records: "committed" })

      // Every call names the note's own path, never a bare directory.
      for (const call of calls) expect(call).toContain(noteIn(repoRoot))
    }))

  test("a transport failure passes through untouched — the tag reaches the graph, not a wrapper", async () => {
    const limit = new UsageLimit({ resetAt: "2026-08-18T20:00:00Z", source: "api_retry", sessionId: "s" })
    const failing: ClaudeAgentService = { prompt: () => Effect.fail(limit) }
    const result = await runWith(discover.run(INPUT), failing, scriptedShell([]).service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe(limit)
  })
})
