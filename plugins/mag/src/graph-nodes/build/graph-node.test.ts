import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import {
  BuildCommitFailed,
  BuildDisputed,
  BuildGitFailed,
  BuildHeadMoved,
  BuildNoCommits,
  BuildResumeEmpty,
  BuildRunRootMissing,
  BuildSummaryEmpty,
  BuildSummaryWriteFailed,
  BuildWorkdirDirty
} from "mag/graph-nodes/build/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/build/examples"
import { build } from "mag/graph-nodes/build/graph-node"
import { UsageLimit } from "mag/runtime/claude/errors"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

/**
 * In-order scripted shell, as in branch's tests. On a run whose builder left the tree dirty, the
 * full sequence is: baseline `rev-parse`, the pre-agent dirty-tree probe, [the agent], the
 * post-agent leftover probe, `add -A`, the staged-index check (`diff --cached --quiet`), `commit`,
 * the commit count, and the final `rev-parse` for `headSha`. Most cases script both probes clean
 * (`out("")`) so the node's own commit stays a no-op and the rest of the sequence is unchanged.
 */
const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

/** `git diff --cached --quiet`: exit 0 means nothing staged, exit 1 means the index differs from HEAD. */
const diffCached = (hasStaged: boolean): ShellResult => ({ exitCode: hasStaged ? 1 : 0, stdout: "", stderr: "" })

/** A stub agent that records the request and answers with a canned reply, `service.test.ts`'s idiom. */
const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { summary: "did the work" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.42,
        attempts: 1,
        ...reply
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** A real, disposable run root — writing the summary artifact needs one, `design/graph-node.test.ts`'s `withDirs` idiom. */
const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "build-node-"))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

/** No FS ever reached from this: only for tests that fail before the write (a fake path is fine). */
const RUN = testRunInfo()

const INPUT = inputExamples[0]!

/**
 * `runPromise`, not `runSync`: `build` always provides `platform` internally (`graph-node.ts`),
 * and a real `FileSystem` write genuinely suspends the fiber (`design/graph-node.test.ts`'s note).
 */
const runWith = <A, E>(effect: Effect.Effect<A, E, never>, shell: ShellService, agent: ClaudeAgentService, run: RunInfoService = RUN) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

describe("build", () => {
  test("the fixtures decode against build's own schemas", () => {
    if (!isSchemaHandle(build.input)) throw new Error("build.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(build.input)(example)
    if (!isSchemaHandle(build.success)) throw new Error("build.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(build.success)(example)
  })

  test("the prompt is near-empty, the plan and the branch and nothing of the ticket, and the agent runs in workRoot", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")])
      const agent = stubAgent()
      await runWith(build.run(INPUT), service, agent.service, testRunInfo({ runRoot }))

      expect(agent.requests).toHaveLength(1)
      const request = agent.requests[0]!
      expect(request.cwd).toBe("/repo")
      expect(request.prompt).toContain(`Work through the plan at ${INPUT.planPath} one task at a time`)
      expect(request.prompt).toContain(INPUT.branch)
      // The plan is the whole contract: the ticket is not cited, named or titled here.
      expect(request.prompt).not.toContain("Read the ticket at")
      expect(request.prompt).not.toContain(`Ticket ${INPUT.ticket}`)
      // Every dispatch is charged to prove acceptance criteria through the shipped symbol.
      expect(request.prompt).toContain("executes the exported symbol that ships")
      expect(calls.map((call) => call.argv)).toStrictEqual([
        ["git", "rev-parse", "HEAD"],
        ["git", "status", "--porcelain"],
        ["git", "status", "--porcelain"],
        ["git", "rev-list", "--count", "aaa111..HEAD"],
        ["git", "rev-parse", "HEAD"]
      ])
    }))

  test("an addendum is spliced verbatim; without one the prompt is unchanged and review-ignorant", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent()
      await runWith(
        build.run(INPUT),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        bare.service,
        run
      )
      expect(bare.requests[0]!.prompt).not.toContain("reviewer")

      const amended = stubAgent()
      const withAddendum = inputExamples[1]!
      await runWith(
        build.run(withAddendum),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        amended.service,
        run
      )
      expect(amended.requests[0]!.prompt).toContain(withAddendum.addendum!)
      // The node splices the caller's words and adds none of its own around them.
      expect(amended.requests[0]!.prompt.endsWith(`\n\n${withAddendum.addendum!}`)).toBe(true)
    }))

  test("the artifact-discipline sentence reaches all three dispatch shapes", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const shell = () => scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service
      const sentence =
        "Write every artifact in its final state: a comment is one line stating a constraint the code\n" +
        "cannot show, never a ticket citation, and a correction rewrites the prose it affects in place."

      const bare = stubAgent()
      await runWith(build.run(INPUT), shell(), bare.service, run)
      expect(bare.requests[0]!.prompt).toContain(sentence)

      const addendum = stubAgent()
      await runWith(build.run(inputExamples[1]!), shell(), addendum.service, run)
      expect(addendum.requests[0]!.prompt).toContain(sentence)

      const sendBack = stubAgent()
      await runWith(build.run(inputExamples[2]!), shell(), sendBack.service, run)
      expect(sendBack.requests[0]!.prompt).toContain(sentence)
    }))

  test("the input's agent reaches the dispatch verbatim; without one, none is sent", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent()
      await runWith(
        build.run(INPUT),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        bare.service,
        run
      )
      expect(bare.requests[0]!.agent).toBeUndefined()

      const hardwired = stubAgent()
      await runWith(
        build.run(inputExamples[1]!),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        hardwired.service,
        run
      )
      expect(hardwired.requests[0]!.agent).toBe("effect-expert")
    }))

  test("the input's model reaches the dispatch verbatim; without one, none is sent", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent()
      await runWith(
        build.run(INPUT),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        bare.service,
        run
      )
      expect(bare.requests[0]!.model).toBeUndefined()

      const assigned = stubAgent()
      await runWith(
        build.run(inputExamples[1]!),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        assigned.service,
        run
      )
      expect(assigned.requests[0]!.model).toBe("sonnet")
    }))

  test("the success carries the summary's artifact path, sessions and cost, plus the measured commits", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("2\n"), out("bbb222\n")])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        summaryPath: `${runRoot}/build-1.md`,
        sessions: ["stub-session"],
        costUsd: 0.42,
        commits: 2,
        headSha: "bbb222",
        sessionRef: "stub-session"
      })
      expect(readFileSync(`${runRoot}/build-1.md`, "utf8")).toBe("did the work")
    }))

  test("a clean tree and zero commits is still BuildNoCommits — the mechanical commit rescues refused work, never absent work", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("0\n")])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildNoCommits)
      expect((result.failure as BuildNoCommits).commits).toBe(0)
      for (const call of calls) {
        expect(call.argv).not.toContain("add")
        expect(call.argv).not.toContain("commit")
      }
    }))

  test("a send-back pass with findings, a clean tree and a dispute reply is BuildDisputed, not BuildNoCommits", () =>
    withRunRoot(async (runRoot) => {
      const sendBack = inputExamples[2]!
      const { calls, service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("0\n"), out("aaa111\n")])
      const agent = stubAgent({
        verdict: { summary: "investigated", dispute: ["both findings were already fixed at HEAD"] }
      })
      const result = await runWith(build.run(sendBack), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildDisputed)
      const disputed = result.failure as BuildDisputed
      expect(disputed.summaryPath).toBe(`${runRoot}/build-1.md`)
      expect(disputed.findingsPath).toBe(sendBack.findingsPath!)
      expect(disputed.headSha).toBe("aaa111")
      expect(disputed.commits).toBe(0)
      expect(disputed.sessions).toStrictEqual(["stub-session"])
      expect(readFileSync(disputed.disputePath, "utf8")).toBe(
        `Disputes ${sendBack.findingsPath}\n\n- both findings were already fixed at HEAD`
      )
      for (const call of calls) {
        expect(call.argv).not.toContain("add")
        expect(call.argv).not.toContain("commit")
      }
    }))

  test("no findingsPath, count 0, a dispute in the reply anyway still fails BuildNoCommits", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("0\n")])
      const agent = stubAgent({ verdict: { summary: "did nothing", dispute: ["nothing was asked of me"] } })
      const result = await runWith(build.run(INPUT), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildNoCommits)
      // The gate is the input's own findingsPath, never the reply: no extra rev-parse or artifact
      // write happened past the count.
      expect(calls).toHaveLength(4)
    }))

  test("findingsPath present, count 0, no dispute in the reply — silence is not a dispute, still BuildNoCommits", () =>
    withRunRoot(async (runRoot) => {
      const sendBack = inputExamples[2]!
      const { calls, service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("0\n")])
      const result = await runWith(build.run(sendBack), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildNoCommits)
      expect(calls).toHaveLength(4)
    }))

  test("a whitespace-only dispute is silence, not an argument — still BuildNoCommits", () =>
    withRunRoot(async (runRoot) => {
      const sendBack = inputExamples[2]!
      const { calls, service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("0\n")])
      const agent = stubAgent({ verdict: { summary: "investigated", dispute: ["   \n"] } })
      const result = await runWith(build.run(sendBack), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildNoCommits)
      // Same gate as silence: no second rev-parse, no artifact write.
      expect(calls).toHaveLength(4)
    }))

  test("a send-back pass that commits and disputes carries the pair on its ordinary success, not only on BuildDisputed", () =>
    withRunRoot(async (runRoot) => {
      const sendBack = inputExamples[2]!
      const { service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")])
      const agent = stubAgent({
        verdict: { summary: "fixed findings 1 and 2", dispute: ["finding 3 was already fixed at HEAD"] }
      })
      const result = await runWith(build.run(sendBack), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.commits).toBe(1)
      expect(result.success.findingsPath).toBe(sendBack.findingsPath!)
      expect(result.success.disputePath).toBe(`${runRoot}/dispute-1.md`)
      expect(readFileSync(result.success.disputePath!, "utf8")).toBe(
        `Disputes ${sendBack.findingsPath}\n\n- finding 3 was already fixed at HEAD`
      )
      // The summary keeps its own prefix and numbering, unaffected by the dispute write.
      expect(result.success.summaryPath).toBe(`${runRoot}/build-1.md`)
    }))

  test("the gate is still the input field on the committed path — no findingsPath, commits 1, a dispute in the reply changes nothing", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")])
      const agent = stubAgent({ verdict: { summary: "did the work", dispute: ["unsolicited dispute"] } })
      const result = await runWith(build.run(INPUT), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.findingsPath).toBeUndefined()
      expect(result.success.disputePath).toBeUndefined()
      expect(readdirSync(runRoot)).toStrictEqual(["build-1.md"])
    }))

  test("a whitespace-only dispute is silence on the committed path too — no pair, no artifact", () =>
    withRunRoot(async (runRoot) => {
      const sendBack = inputExamples[2]!
      const { service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")])
      const agent = stubAgent({ verdict: { summary: "did the work", dispute: ["   \n"] } })
      const result = await runWith(build.run(sendBack), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.disputePath).toBeUndefined()
      expect(readdirSync(runRoot)).toStrictEqual(["build-1.md"])
    }))

  test("the send-back prompt states a pass may commit fixes and dispute the rest, with no make-no-commit coupling", () =>
    withRunRoot(async (runRoot) => {
      const sendBack = inputExamples[2]!
      const agent = stubAgent()
      await runWith(
        build.run(sendBack),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        agent.service,
        testRunInfo({ runRoot })
      )
      const prompt = agent.requests[0]!.prompt
      expect(prompt).not.toContain("make no commit")
      expect(prompt).toContain("A single pass may commit fixes and")
      expect(prompt).toContain("dispute the rest.")
      expect(prompt).toContain("Dispute a finding only when its defect is not there; fix a defect you accept your own way, whatever the reviewer suggested.")
    }))

  test("a zero-forward-commit count with a moved HEAD is BuildHeadMoved, not a dispute and not BuildNoCommits", () =>
    withRunRoot(async (runRoot) => {
      const sendBack = inputExamples[2]!
      // The final `rev-parse HEAD` returns a sha other than the baseline `aaa111`: `git rev-list
      // --count before..HEAD` is 0 whenever HEAD is not *ahead* of `before`, which a `git reset
      // --hard HEAD~1` satisfies too, so "zero commits means HEAD didn't move" is false there:
      // this must not read as a dispute, nor be folded into BuildNoCommits's "the
      // agent did nothing" — the branch lost commits and the previously-verified tree is gone.
      const { calls, service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("0\n"), out("zzz999\n")])
      const agent = stubAgent({
        verdict: { summary: "investigated", dispute: ["both findings were already fixed at HEAD"] }
      })
      const result = await runWith(build.run(sendBack), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildHeadMoved)
      const moved = result.failure as BuildHeadMoved
      expect(moved.expected).toBe("aaa111")
      expect(moved.observed).toBe("zzz999")
      // No dispute artifact was written for a tree that was never verified.
      for (const call of calls) expect(call.argv).not.toContain("add")
    }))

  test("findingsPath names the file and states the dispute option; without it the prompt is unchanged", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent()
      await runWith(
        build.run(INPUT),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        bare.service,
        run
      )
      expect(bare.requests[0]!.prompt).not.toContain("dispute")
      expect(bare.requests[0]!.prompt).not.toContain("reviewer")
      // The contract re-derivation sentence is send-back-only, same as the block it lives in.
      expect(bare.requests[0]!.prompt).not.toContain("re-derive the contract")

      const sendBack = inputExamples[2]!
      const withFindings = stubAgent()
      await runWith(
        build.run(sendBack),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        withFindings.service,
        run
      )
      expect(withFindings.requests[0]!.prompt).toContain(sendBack.findingsPath!)
      expect(withFindings.requests[0]!.prompt).toContain("dispute")
      expect(withFindings.requests[0]!.prompt).toContain("re-derive the contract")
    }))

  test("a blank summary is BuildSummaryEmpty — nothing worth an artifact", async () => {
    const { service } = scriptedShell([out("aaa111\n"), out("")])
    const agent = stubAgent({ verdict: { summary: "  \n" } })
    const result = await runWith(build.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BuildSummaryEmpty)
    expect((result.failure as BuildSummaryEmpty).sessions).toStrictEqual(["stub-session"])
  })

  test("a run root that can't be written is BuildSummaryWriteFailed, carrying the sessions already spent", () =>
    withRunRoot(async (base) => {
      // A real file sitting where a path component of the run root needs to be a directory:
      // `design/graph-node.test.ts`'s ENOTDIR trick, cheaply reproducing the write-failure path
      // without mocking `FileSystem` itself.
      const blocker = join(base, "blocker")
      writeFileSync(blocker, "not a directory")
      const brokenRoot = join(blocker, "subdir")

      const { service } = scriptedShell([out("aaa111\n"), out("")])
      const agent = stubAgent()
      const result = await runWith(build.run(INPUT), service, agent.service, testRunInfo({ runRoot: brokenRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildSummaryWriteFailed)
      const failure = result.failure as BuildSummaryWriteFailed
      expect(failure.runRoot).toBe(brokenRoot)
      expect(failure.detail.length).toBeGreaterThan(0)
      expect(failure.sessions).toStrictEqual(["stub-session"])
    }))

  test("an empty runRoot is a wiring bug, not a data problem — fails before any dispatch", async () => {
    const agent = stubAgent()
    const result = await runWith(build.run(INPUT), scriptedShell([]).service, agent.service, testRunInfo({ runRoot: "" }))

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BuildRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  test("a transport failure passes through untouched — the tag reaches the graph, not a wrapper", async () => {
    const { service } = scriptedShell([out("aaa111\n"), out("")])
    const limit = new UsageLimit({ resetAt: "2026-08-18T20:00:00Z", source: "api_retry", sessionId: "s" })
    const failing: ClaudeAgentService = { prompt: () => Effect.fail(limit) }
    const result = await runWith(build.run(INPUT), service, failing)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe(limit)
  })

  test("a failing baseline git call is BuildGitFailed — the agent is never spawned without one", async () => {
    const { service } = scriptedShell([{ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }])
    const agent = stubAgent()
    const result = await runWith(build.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BuildGitFailed)
    expect((result.failure as BuildGitFailed).exitCode).toBe(128)
    expect(agent.requests).toHaveLength(0)
  })

  test("a tree already dirty before the agent runs is BuildWorkdirDirty — no session is spawned, nothing is swept into a commit", async () => {
    const { calls, service } = scriptedShell([out("aaa111\n"), out("?? unrelated-scratch.md\n")])
    const agent = stubAgent()
    const result = await runWith(build.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BuildWorkdirDirty)
    expect((result.failure as BuildWorkdirDirty).paths).toStrictEqual(["unrelated-scratch.md"])
    expect(agent.requests).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })

  test("an unstaged tracked modification (leading-space status code) names its real path, not a truncated one", async () => {
    const { service } = scriptedShell([out("aaa111\n"), out(" M other.ts\n M src-config.ts\n")])
    const agent = stubAgent()
    const result = await runWith(build.run(INPUT), service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BuildWorkdirDirty)
    expect((result.failure as BuildWorkdirDirty).paths).toStrictEqual(["other.ts", "src-config.ts"])
    expect(agent.requests).toHaveLength(0)
  })

  test("the post-agent leftover probe failing is BuildGitFailed too, distinct from the pre-agent one", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        { exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }
      ])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildGitFailed)
      expect((result.failure as BuildGitFailed).argv).toBe("git status --porcelain")
    }))

  test("uncommitted work (tracked or untracked) after the session is staged and committed by the node", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        out("?? new.ts\n"),
        out(""),
        diffCached(true),
        out(""),
        out("1\n"),
        out("bbb222\n")
      ])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.commits).toBe(1)
      expect(result.success.headSha).toBe("bbb222")
      expect(calls).toHaveLength(8)
      expect(calls[0]!.argv).toStrictEqual(["git", "rev-parse", "HEAD"])
      expect(calls[1]!.argv).toStrictEqual(["git", "status", "--porcelain"])
      expect(calls[2]!.argv).toStrictEqual(["git", "status", "--porcelain"])
      expect(calls[3]!.argv).toStrictEqual(["git", "add", "-A"])
      expect(calls[4]!.argv).toStrictEqual(["git", "diff", "--cached", "--quiet"])
      expect(calls[5]!.argv[0]).toBe("git")
      expect(calls[5]!.argv[1]).toBe("commit")
      expect(calls[5]!.argv[2]).toBe("-m")
      expect(calls[5]!.argv[3]).toContain(INPUT.ticket)
      expect(calls[5]!.argv[3]).toContain("build node")
      expect(calls[6]!.argv).toStrictEqual(["git", "rev-list", "--count", "aaa111..HEAD"])
      expect(calls[7]!.argv).toStrictEqual(["git", "rev-parse", "HEAD"])
      expect(calls.every((call) => call.cwd === "/repo")).toBe(true)
    }))

  test("a committing builder's clean tree draws no commit of the node's own — the whole sequence, not a flag", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      expect(calls).toHaveLength(5)
      for (const call of calls) {
        expect(call.argv).not.toContain("add")
        expect(call.argv).not.toContain("commit")
      }
    }))

  test("a dirty probe that stages nothing (e.g. a submodule with untracked content) is a no-op, not a failure", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        out(" M sub\n"),
        out(""),
        diffCached(false),
        out("1\n"),
        out("bbb222\n")
      ])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      // The builder's own commit is what `commits` counts; the node issued no commit of its own.
      expect(result.success.commits).toBe(1)
      expect(calls).toHaveLength(7)
      expect(calls[3]!.argv).toStrictEqual(["git", "add", "-A"])
      expect(calls[4]!.argv).toStrictEqual(["git", "diff", "--cached", "--quiet"])
      for (const call of calls) expect(call.argv).not.toContain("commit")
    }))

  test("a builder that committed once and left more behind — the node's commit and the count compose", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        out("?? more.ts\n"),
        out(""),
        diffCached(true),
        out(""),
        out("2\n"),
        out("ccc333\n")
      ])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.commits).toBe(2)
      expect(result.success.headSha).toBe("ccc333")
      expect(calls.some((call) => call.argv[1] === "commit")).toBe(true)
    }))

  test("headSha is measured after the node's own commit, not before it", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        out("?? new.ts\n"),
        out(""),
        diffCached(true),
        out(""),
        out("1\n"),
        out("post-commit-sha\n")
      ])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      // The two `rev-parse HEAD` replies are scripted to distinct shas; the returned headSha can only
      // be the second one if this measurement runs after `commitAgentLeftovers`, not before it.
      expect(result.success.headSha).toBe("post-commit-sha")
    }))

  test("a failing `git add -A` is BuildCommitFailed, carrying the stderr, stdout and the sessions already spent", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        out("?? new.ts\n"),
        { exitCode: 128, stdout: "", stderr: "fatal: unable to write new index file\n" }
      ])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildCommitFailed)
      const failure = result.failure as BuildCommitFailed
      expect(failure.argv).toBe("git add -A")
      expect(failure.exitCode).toBe(128)
      expect(failure.stderr).toBe("fatal: unable to write new index file")
      expect(failure.stdout).toBe("")
      expect(failure.sessions).toStrictEqual(["stub-session"])
      // The tree is left exactly as the failure leaves it: no further git call was issued.
      expect(calls).toHaveLength(4)
    }))

  test("a failing `git commit` is BuildCommitFailed, and no further git call is issued", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        out("?? new.ts\n"),
        out(""),
        diffCached(true),
        { exitCode: 1, stdout: "", stderr: "fatal: empty ident name (for <>) not allowed\n" }
      ])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildCommitFailed)
      const failure = result.failure as BuildCommitFailed
      expect(failure.argv).toBe("git commit -m <message>")
      expect(failure.exitCode).toBe(1)
      expect(failure.stderr).toBe("fatal: empty ident name (for <>) not allowed")
      expect(failure.stdout).toBe("")
      expect(calls).toHaveLength(6)
    }))

  test("a `git commit` failure's stdout (e.g. \"nothing to commit\") rides the error alongside stderr", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        out("?? new.ts\n"),
        out(""),
        diffCached(true),
        { exitCode: 1, stdout: "nothing to commit, working tree clean\n", stderr: "" }
      ])
      const result = await runWith(build.run(INPUT), service, stubAgent().service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BuildCommitFailed)
      const failure = result.failure as BuildCommitFailed
      expect(failure.stdout).toBe("nothing to commit, working tree clean")
      expect(failure.stderr).toBe("")
    }))

  test("`resume` reaches the transport, and the resumed prompt drops the framing but keeps the standing discipline", () =>
    withRunRoot(async (runRoot) => {
      const resumed = inputExamples[3]!
      const agent = stubAgent()
      await runWith(
        build.run(resumed),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        agent.service,
        testRunInfo({ runRoot })
      )

      expect(agent.requests).toHaveLength(1)
      const request = agent.requests[0]!
      expect(request.resume).toBe(resumed.resume)
      expect(request.prompt).toContain(resumed.addendum!)
      expect(request.prompt).not.toContain(resumed.planPath)
      expect(request.prompt).not.toContain(resumed.branch)
      // The acceptance-criterion proof sentence and the artifact-write sentence are discipline, not
      // framing: a resumed pass is still charged to prove what it fixes, so both must survive
      // rather than being gated on a fresh pass only.
      expect(request.prompt).toContain("executes the exported symbol that ships")
      expect(request.prompt).toContain("Write every artifact in its final state")
    }))

  test("without `resume`, no resume field reaches the transport", () =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent()
      await runWith(
        build.run(INPUT),
        scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service,
        agent.service,
        testRunInfo({ runRoot })
      )
      expect(agent.requests[0]!.resume).toBeUndefined()
    }))

  test("`sessionRef` on success is the reply's pinned id, `sessions[0]`, not just any session in the array", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")])
      const agent = stubAgent({ sessions: ["pinned-id", "other-session"] })
      const result = await runWith(build.run(INPUT), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.sessionRef).toBe("pinned-id")
      expect(result.success.sessions).toStrictEqual(["pinned-id", "other-session"])
    }))

  test("`resume` with neither `findingsPath` nor `addendum` is BuildResumeEmpty, fails before any dispatch", async () => {
    const agent = stubAgent()
    const result = await runWith(
      build.run({ ...INPUT, resume: "a1b2c3" }),
      scriptedShell([]).service,
      agent.service
    )

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(BuildResumeEmpty)
    expect(agent.requests).toHaveLength(0)
  })

  test("the salvage commit message names the ticket, the build node, and one Claude-Session trailer per session", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([
        out("aaa111\n"),
        out(""),
        out("?? new.ts\n"),
        out(""),
        diffCached(true),
        out(""),
        out("1\n"),
        out("bbb222\n")
      ])
      const agent = stubAgent({ sessions: ["s1", "s2"] })
      const result = await runWith(build.run(INPUT), service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      const message = calls[5]!.argv[3]!
      expect(message.startsWith(`${INPUT.ticket}: work committed by the build node`)).toBe(true)
      expect(message).toContain("Claude-Session: s1")
      expect(message).toContain("Claude-Session: s2")
    }))
})
