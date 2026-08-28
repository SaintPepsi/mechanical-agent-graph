import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer, Option, Result, Schema } from "effect"
import {
  ReviewBlocked,
  ReviewDiffWriteFailed,
  ReviewDisputeIncomplete,
  ReviewDisputeRejected,
  ReviewFindingsWriteFailed,
  ReviewGitFailed,
  ReviewHeadMoved,
  ReviewRunRootMissing
} from "mag/graph-nodes/review-diff/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/review-diff/examples"
import { reviewDiff } from "mag/graph-nodes/review-diff/graph-node"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { SWEEP_LABEL, SWEEP_TRIGGER } from "mag/skills/design/reference-sweep"
import { compileReviewBrief } from "mag/skills/review-brief"
import { testJournalLayer, testRunInfo } from "mag/test/node-fixture"

const DIFF = "diff --git a/x.ts b/x.ts\n-old\n+new\n"

const diffShell = (reply: ShellResult = { exitCode: 0, stdout: DIFF, stderr: "" }) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

/**
 * Routes by argv, the way four git calls sharing one `ShellService` stub have to be told apart:
 * `rev-parse` gets `head`, `git diff <base>...HEAD` gets `diff`, `--name-only` gets `changed`,
 * `ls-files` gets `declared`. Anything
 * else fails loudly rather than silently reusing a default, since a fifth unexpected argv should
 * fail the test, not be misread as one of the four. `head` defaults to `INPUT`'s own `headSha`, the
 * value every test not deliberately provoking `ReviewHeadMoved` needs the checkout to agree with.
 * Stamped with its trailing newline (probed: `git rev-parse HEAD` ends in one) — the node's own
 * `.trim()` is what a missing trim would turn red here.
 */
const gitStub = (
  { diff = DIFF, changed = "", declared = "", head = INPUT.headSha }: {
    diff?: string
    changed?: string
    declared?: string
    head?: string
  } = {}
) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      if (argv[1] === "rev-parse") return Effect.succeed({ exitCode: 0, stdout: `${head}\n`, stderr: "" })
      if (argv.includes("--name-only")) return Effect.succeed({ exitCode: 0, stdout: changed, stderr: "" })
      if (argv[1] === "ls-files") return Effect.succeed({ exitCode: 0, stdout: declared, stderr: "" })
      if (argv[1] === "diff") return Effect.succeed({ exitCode: 0, stdout: diff, stderr: "" })
      throw new Error(`gitStub: unexpected argv ${argv.join(" ")}`)
    }
  }
  return { calls, service }
}

/** `ls-files` alone fails, `rev-parse` and the diff reads pass — the exact split `ReviewGitFailed`'s test needs. */
const failingLsFilesShell = (result: ShellResult) => {
  const calls: Array<{ argv: string[]; cwd: string | undefined }> = []
  const service: ShellService = {
    run: (argv, options) => {
      calls.push({ argv: [...argv], cwd: options?.cwd })
      if (argv[1] === "rev-parse") return Effect.succeed({ exitCode: 0, stdout: `${INPUT.headSha}\n`, stderr: "" })
      if (argv[1] === "ls-files") return Effect.succeed(result)
      return Effect.succeed({ exitCode: 0, stdout: argv.includes("--name-only") ? "" : DIFF, stderr: "" })
    }
  }
  return { calls, service }
}

const stubAgent = (blocking: readonly string[], notes: readonly string[] = [], questions: readonly string[] = []) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { blocking, notes, questions } as A,
        result: {},
        sessions: ["review-session"],
        costUsd: 0.31,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** Deletes a fixture directory, and only a fixture directory: anything outside tmpdir is refused. */
const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

/** A real, disposable run root — writing the findings artifact needs one, `design/graph-node.test.ts`'s `withDirs` idiom. */
const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "review-diff-node-"))
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
 * `runPromise`, not `runSync`: `reviewDiff` always provides `platform` internally (`graph-node.ts`),
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

describe("review-diff", () => {
  test("the fixtures decode against review-diff's own schemas", () => {
    if (!isSchemaHandle(reviewDiff.input)) throw new Error("reviewDiff.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(reviewDiff.input)(example)
    if (!isSchemaHandle(reviewDiff.success)) throw new Error("reviewDiff.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(reviewDiff.success)(example)
  })

  test("the merge-base diff is written to the run root and the prompt names that file, read-only, in workRoot", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub()
      const agent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      // The head-gate's own read comes first, ahead of the diff and the principles reads.
      expect(shell.calls.map((call) => call.argv)).toStrictEqual([
        ["git", "rev-parse", "HEAD"],
        ["git", "diff", "main...HEAD"],
        ["git", "diff", "--no-renames", "--name-only", "-z", "main...HEAD"],
        ["git", "ls-files", "-z", "--full-name", "--", ":/PRINCIPLES.md", ":/*/PRINCIPLES.md"]
      ])
      expect(shell.calls.every((call) => call.cwd === "/repo")).toBe(true)
      expect(agent.requests).toHaveLength(1)
      const request = agent.requests[0]!
      expect(request.cwd).toBe("/repo")
      expect(request.prompt).toContain(`Ticket ${INPUT.ticket}: ${INPUT.title}`)
      expect(request.prompt).toContain(`Read the ticket at \`${INPUT.ticketPath}\`.`)
      // No diff bytes in argv — the prompt names the path, not the content.
      expect(request.prompt).not.toContain(DIFF)
      expect(request.prompt).toContain(`${runRoot}/diff-1.patch`)
      expect(request.prompt).toContain(`git diff main...${INPUT.headSha}`)
      expect(request.prompt).toContain("Change nothing.")
      // The file the prompt names holds exactly this pass's own `git diff <base>...HEAD` read.
      expect(readFileSync(`${runRoot}/diff-1.patch`, "utf8")).toBe(DIFF)
      // The sweep gate is a prompt sentence, not a standing mechanical check: an ordinary run makes no extra git call.
      expect(shell.calls).toHaveLength(4)
      expect(agent.requests).toHaveLength(1)
    }))

  test("a declared file governing a changed path names that path and carries the blocking-criteria sentence", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub({ changed: "pkg/a/x.ts\0", declared: "pkg/a/PRINCIPLES.md\0" })
      const agent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain("pkg/a/PRINCIPLES.md")
      expect(prompt).toContain("A rule stated")
      expect(prompt).toContain("blocking finding, like any other")
    }))

  test("no declared PRINCIPLES.md leaves the prompt exactly the ticket, the diff line, the diff charter and the unconditional sweep gate", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub({ changed: "x.ts\0", declared: "" })
      const agent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      const diffPath = `${runRoot}/diff-1.patch`
      expect(agent.requests[0]!.prompt).toBe(
        [
          `Ticket ${INPUT.ticket}: ${INPUT.title}`,
          "",
          `Read the ticket at \`${INPUT.ticketPath}\`.`,
          "",
          // The line count is pinned as a literal, not
          // `DIFF.split("\n").length` (4) — `DIFF` is 3 lines plus a trailing newline, and the
          // node's own `lines` computation strips that trailing newline before splitting, so this
          // asserts the real count rather than reproducing an off-by-one bug.
          `Review the diff at ${diffPath} (3 lines, \`git diff main...${INPUT.headSha}\`): read every line, paging past any truncation notice. Change nothing.`,
          "",
          ...compileReviewBrief("diff"),
          "",
          `When this diff ${SWEEP_TRIGGER} and carries a design record, that record states a ${SWEEP_LABEL}: the repo-wide grep for the old name and every hit, each hit owned by an edit in this diff or carrying a one-line reason its wording stays. A design record present without one is a blocking finding; a diff with no design record is nothing this gate checks.`
        ].join("\n")
      )
    }))

  test("the diff charter carries the diff target, the three output channels and the fresh-eyes skim, and none of the plan target's audits", () =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), gitStub().service, agent.service, testRunInfo({ runRoot }))

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain("You are an adversarial reviewer. Find where the target fails to meet the ticket.")
      expect(prompt).toContain("does the code as written do what the ticket requires?")
      expect(prompt).toContain("fresh-eyes skim of the whole branch")
      expect(prompt).toContain("Duplicated logic across sibling files is a note")
      expect(prompt).toContain("- blocking: shipped as-is")
      expect(prompt).toContain("- notes: everything else")
      expect(prompt).toContain("- questions: a context-free")
      expect(prompt).not.toContain("Prior-art hunt:")
      expect(prompt).not.toContain("Structure audit:")
      expect(prompt).not.toContain("re-review")
    }))

  test("priorFindingsPath makes the pass a re-review: the prior findings are named, the delta is judged, and the fresh hunt framing is gone", () =>
    withRunRoot(async (runRoot) => {
      const delta = inputExamples[1]!
      const agent = stubAgent([])
      await runWith(reviewDiff.run(delta), gitStub({ head: delta.headSha }).service, agent.service, testRunInfo({ runRoot }))

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(`A prior pass raised blocking findings, recorded at ${delta.priorFindingsPath},`)
      expect(prompt).toContain("Judge whether each prior blocking finding is fixed and whether the change introduced a new blocker.")
      expect(prompt).not.toContain("Find where the target fails to meet the ticket.")
      // The rest of the charter still applies: the re-review only swaps the framing.
      expect(prompt).toContain("- blocking: shipped as-is")
      expect(prompt).toContain(delta.addendum!)
    }))

  test("notes and questions are recorded in the findings file and never gate", () =>
    withRunRoot(async (runRoot) => {
      const result = await runWith(
        reviewDiff.run(INPUT),
        gitStub().service,
        stubAgent([], ["x.ts:3 the helper name shadows the module's"], ["is the 2000-line cap intentional?"]).service,
        testRunInfo({ runRoot })
      )

      expect(Result.isSuccess(result)).toBe(true)
      expect(readFileSync(`${runRoot}/review-diff-1.md`, "utf8")).toBe(
        `Reviewed at ${INPUT.headSha}\n\nNo blocking findings.\n\nNotes:\n- x.ts:3 the helper name shadows the module's\n\nQuestions:\n- is the 2000-line cap intentional?`
      )
    }))

  test("the sweep gate is unconditional and sits ahead of a populated principles block, matching the envisioned shell's region order", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub({ changed: "pkg/a/x.ts\0", declared: "pkg/a/PRINCIPLES.md\0" })
      const agent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(SWEEP_TRIGGER)
      expect(prompt).toContain(SWEEP_LABEL)
      expect(prompt).toContain("A design record present without one is a blocking finding")
      expect(prompt.indexOf(SWEEP_LABEL)).toBeLessThan(prompt.indexOf("pkg/a/PRINCIPLES.md"))
    }))

  test("the gate's obligation is conditioned on the diff carrying a design record, so diffs from a graph with no design node and no designPath  hit an explicit no-op clause rather than an unsatisfiable one", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub({ changed: "x.ts\0", declared: "" })
      const agent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(`${SWEEP_TRIGGER} and carries a design record`)
      expect(prompt).toContain("a diff with no design record is nothing this gate checks")
      // Must not bind the blocking clause to any diff lacking the label, design record or not.
      expect(prompt).not.toContain(`the design record in it states a ${SWEEP_LABEL}`)
    }))

  test("a declared file that governs nothing (a sibling package) never appears in the prompt", () =>
    withRunRoot(async (runRoot) => {
      const shell = gitStub({ changed: "pkg/b/y.ts\0", declared: "pkg/a/PRINCIPLES.md\0" })
      const agent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      expect(agent.requests[0]!.prompt).not.toContain("PRINCIPLES.md")
    }))

  test("ls-files exiting non-zero is ReviewGitFailed, the agent is never spawned", () =>
    withRunRoot(async (runRoot) => {
      const shell = failingLsFilesShell({ exitCode: 128, stdout: "", stderr: "fatal: bad object\n" })
      const agent = stubAgent([])
      const result = await runWith(reviewDiff.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewGitFailed)
      expect((result.failure as ReviewGitFailed).exitCode).toBe(128)
      expect(agent.requests).toHaveLength(0)
    }))

  test("a headSha that disagrees with the checkout's own HEAD is ReviewHeadMoved, before any other read or dispatch", () =>
    withRunRoot(async (runRoot) => {
      const observed = "deadbeef00000000000000000000000000000000"
      const shell = gitStub({ head: observed })
      const agent = stubAgent([])
      const result = await runWith(reviewDiff.run(INPUT), shell.service, agent.service, testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewHeadMoved)
      const moved = result.failure as ReviewHeadMoved
      expect(moved.expected).toBe(INPUT.headSha)
      expect(moved.observed).toBe(observed)
      expect(agent.requests).toHaveLength(0)
      // Only the gate's own read happened: the diff, the principles reads and the findings write
      // are all downstream of it and never ran.
      expect(shell.calls).toHaveLength(1)
      expect(shell.calls[0]!.argv).toStrictEqual(["git", "rev-parse", "HEAD"])
      expect(existsSync(`${runRoot}/review-diff-1.md`)).toBe(false)
      // Ordering: the gate sits above the diff write too, so a moved tree writes
      // nothing to disk, not just dispatches nothing.
      expect(existsSync(`${runRoot}/diff-1.patch`)).toBe(false)
    }))

  test("the input's agent reaches the dispatch verbatim; without one, none is sent", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent([])
      await runWith(reviewDiff.run(INPUT), gitStub().service, bare.service, run)
      expect(bare.requests[0]!.agent).toBeUndefined()

      const hardwired = stubAgent([])
      await runWith(
        reviewDiff.run(inputExamples[1]!),
        gitStub({ head: inputExamples[1]!.headSha }).service,
        hardwired.service,
        run
      )
      expect(hardwired.requests[0]!.agent).toBe("effect-expert")
    }))

  test("the input's model reaches the dispatch verbatim; without one, none is sent", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent([])
      await runWith(reviewDiff.run(INPUT), gitStub().service, bare.service, run)
      expect(bare.requests[0]!.model).toBeUndefined()

      const assigned = stubAgent([])
      await runWith(
        reviewDiff.run(inputExamples[1]!),
        gitStub({ head: inputExamples[1]!.headSha }).service,
        assigned.service,
        run
      )
      expect(assigned.requests[0]!.model).toBe("opus")
    }))

  test("a clean review succeeds, carrying the reply's sessions and cost, and a passing findings file stamped with the sha it reviewed", () =>
    withRunRoot(async (runRoot) => {
      const result = await runWith(reviewDiff.run(INPUT), gitStub().service, stubAgent([]).service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        findingsPath: `${runRoot}/review-diff-1.md`,
        headSha: INPUT.headSha,
        sessions: ["review-session"],
        costUsd: 0.31
      })
      expect(readFileSync(`${runRoot}/review-diff-1.md`, "utf8")).toBe(`Reviewed at ${INPUT.headSha}\n\nNo blocking findings.\n\nNotes:\nNone.\n\nQuestions:\nNone.`)
    }))

  test("blocking findings are the node's tagged error, findingsPath pointing at the rendered bullets, headSha naming the tree", () =>
    withRunRoot(async (runRoot) => {
      const result = await runWith(
        reviewDiff.run(INPUT),
        gitStub().service,
        stubAgent(["the fix misses the second NUL at line 105"]).service,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewBlocked)
      const blocked = result.failure as ReviewBlocked
      expect(blocked.findingsPath).toBe(`${runRoot}/review-diff-1.md`)
      expect(blocked.headSha).toBe(INPUT.headSha)
      expect(blocked.sessions).toStrictEqual(["review-session"])
      expect(blocked.costUsd).toBe(0.31)
      expect(readFileSync(blocked.findingsPath, "utf8")).toBe(
        `Reviewed at ${INPUT.headSha}\n\n- the fix misses the second NUL at line 105\n\nNotes:\nNone.\n\nQuestions:\nNone.`
      )
    }))

  test("an adjudicating pass that still blocks fails ReviewDisputeRejected, not ReviewBlocked", () =>
    withRunRoot(async (runRoot) => {
      const dispute = inputExamples[2]!
      const result = await runWith(
        reviewDiff.run(dispute),
        gitStub({ head: dispute.headSha }).service,
        stubAgent(["the fix still misses the second NUL"]).service,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewDisputeRejected)
      expect(result.failure._tag).not.toBe("REVIEW_BLOCKED")
      const rejected = result.failure as ReviewDisputeRejected
      expect(rejected.disputePath).toBe(dispute.disputePath!)
      expect(rejected.headSha).toBe(dispute.headSha)
      expect(rejected.findingsPath).toBe(`${runRoot}/review-diff-1.md`)
    }))

  test("an adjudicating pass with an empty verdict succeeds normally, findings artifact written as usual", () =>
    withRunRoot(async (runRoot) => {
      const dispute = inputExamples[2]!
      const result = await runWith(
        reviewDiff.run(dispute),
        gitStub({ head: dispute.headSha }).service,
        stubAgent([]).service,
        testRunInfo({ runRoot })
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.findingsPath).toBe(`${runRoot}/review-diff-1.md`)
      // The dispute pass is not special-cased — it writes its own diff file too.
      expect(existsSync(`${runRoot}/diff-1.patch`)).toBe(true)
    }))

  test("disputePath absent and the verdict blocking still fails ReviewBlocked, unchanged", () =>
    withRunRoot(async (runRoot) => {
      const result = await runWith(
        reviewDiff.run(INPUT),
        gitStub().service,
        stubAgent(["still broken"]).service,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewBlocked)
    }))

  test("the dispatched prompt names both the findings and the dispute file when adjudicating, and is byte-identical to today's when neither is present", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent([])
      await runWith(reviewDiff.run(INPUT), gitStub().service, bare.service, run)
      expect(bare.requests[0]!.prompt).not.toContain("dispute")

      const dispute = inputExamples[2]!
      const withDispute = stubAgent([])
      await runWith(reviewDiff.run(dispute), gitStub({ head: dispute.headSha }).service, withDispute.service, run)
      expect(withDispute.requests[0]!.prompt).toContain(dispute.disputePath!)
      expect(withDispute.requests[0]!.prompt).toContain(dispute.findingsPath!)
      expect(withDispute.requests[0]!.prompt).toContain("dispute")
      // A fresh session has no memory to appeal to, so the prompt cannot claim these are
      // "your prior" findings — it has to name the document instead.
      expect(withDispute.requests[0]!.prompt).not.toContain("your prior")
      // Sent on two edges with disagreeing tree identity, so the wording must not assert either way.
      expect(withDispute.requests[0]!.prompt).not.toContain("instead of committing a fix")
      expect(withDispute.requests[0]!.prompt).not.toContain("the same tree the findings were raised against")
    }))

  test("disputePath alone, with no findingsPath, fails ReviewDisputeIncomplete before any read or dispatch — the two travel together or the input is malformed", () =>
    withRunRoot(async (runRoot) => {
      const dispute = inputExamples[2]!
      const { findingsPath: _findingsPath, ...withoutFindings } = dispute
      const shell = gitStub({ head: dispute.headSha })
      const agent = stubAgent([])
      const result = await runWith(
        reviewDiff.run(withoutFindings as typeof dispute),
        shell.service,
        agent.service,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewDisputeIncomplete)
      const incomplete = result.failure as ReviewDisputeIncomplete
      expect(incomplete.findingsPath).toBeUndefined()
      expect(incomplete.disputePath).toBe(dispute.disputePath!)
      // Fails before the head-gate's own read: no git call, no dispatch.
      expect(shell.calls).toHaveLength(0)
      expect(agent.requests).toHaveLength(0)
    }))

  test("findingsPath alone, with no disputePath, also fails ReviewDisputeIncomplete", () =>
    withRunRoot(async (runRoot) => {
      const dispute = inputExamples[2]!
      const { disputePath: _disputePath, ...withoutDispute } = dispute
      const result = await runWith(
        reviewDiff.run(withoutDispute as typeof dispute),
        gitStub({ head: dispute.headSha }).service,
        stubAgent([]).service,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewDisputeIncomplete)
    }))

  test("two sequential blocking calls against the same run root produce two distinct files, even when the replies reuse the same session id", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const first = await runWith(
        reviewDiff.run(INPUT),
        gitStub().service,
        stubAgent(["first pass finding"]).service,
        run
      )
      expect(Result.isFailure(first)).toBe(true)
      if (Result.isFailure(first)) {
        expect((first.failure as ReviewBlocked).findingsPath).toBe(`${runRoot}/review-diff-1.md`)
      }

      // `stubAgent` always answers "review-session" — naming by session id would collide here.
      // `writeArtifact` counts this run's own prior files instead, so the two stay distinct.
      const delta = inputExamples[1]!
      const second = await runWith(
        reviewDiff.run(delta),
        gitStub({ head: delta.headSha }).service,
        stubAgent(["second pass finding"]).service,
        run
      )
      expect(Result.isFailure(second)).toBe(true)
      if (!Result.isFailure(second)) return
      const blocked = second.failure as ReviewBlocked
      expect(blocked.findingsPath).toBe(`${runRoot}/review-diff-2.md`)
      expect(readFileSync(blocked.findingsPath, "utf8")).toBe(`Reviewed at ${delta.headSha}\n\n- second pass finding\n\nNotes:\nNone.\n\nQuestions:\nNone.`)
      expect(readFileSync(`${runRoot}/review-diff-1.md`, "utf8")).toBe(`Reviewed at ${INPUT.headSha}\n\n- first pass finding\n\nNotes:\nNone.\n\nQuestions:\nNone.`)
      // Each pass writes its own `diff-<N>.patch`, and the `.patch` files must not inflate
      // the `review-diff-` count — `writeArtifact`'s prefix filter is what makes that true.
      expect(existsSync(`${runRoot}/diff-1.patch`)).toBe(true)
      expect(existsSync(`${runRoot}/diff-2.patch`)).toBe(true)
    }))

  test("prompt size does not scale with diff size — a 1 KB and a 512 KB diff produce near-identical prompt sizes, both under argv's 128 KB cap", () =>
    withRunRoot(async (runRoot) => {
      const small = "x".repeat(1024)
      const large = "y".repeat(512 * 1024)

      const smallAgent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), gitStub({ diff: small }).service, smallAgent.service, testRunInfo({ runRoot }))
      const smallPrompt = smallAgent.requests[0]!.prompt

      // Reset this run root's own pass counter (`writeArtifact` counts on-disk files) so the
      // large-diff pass also lands at `diff-1.patch`/`review-diff-1.md`, the same names the small
      // pass used — isolating what changed to the diff's own bytes, not the pass number in a path.
      rmSync(`${runRoot}/diff-1.patch`)
      rmSync(`${runRoot}/review-diff-1.md`)

      const largeAgent = stubAgent([])
      await runWith(reviewDiff.run(INPUT), gitStub({ diff: large }).service, largeAgent.service, testRunInfo({ runRoot }))
      const largePrompt = largeAgent.requests[0]!.prompt

      // The prompt states the diff's own line count, so a 1 KB and
      // a 512 KB diff no longer produce byte-identical prompts — but the stated count is a handful of
      // digits, not the diff itself, so the two prompts stay within a few dozen bytes of each other
      // regardless of which diff is 500x the other's size. That gap staying small, not zero, is what
      // proves the transport still carries a path and a count, never the diff's own bytes.
      expect(Math.abs(largePrompt.length - smallPrompt.length)).toBeLessThan(50)
      expect(largePrompt).toContain("(1 lines, ")
      expect(Buffer.byteLength(largePrompt, "utf8")).toBeLessThan(128 * 1024)
    }))

  test("a failing git read (rev-parse, first in line) is ReviewGitFailed — the agent is never spawned", async () => {
    const shell = diffShell({ exitCode: 128, stdout: "", stderr: "fatal: bad revision\n" })
    const agent = stubAgent([])
    const result = await runWith(reviewDiff.run(INPUT), shell.service, agent.service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ReviewGitFailed)
    expect((result.failure as ReviewGitFailed).exitCode).toBe(128)
    expect(agent.requests).toHaveLength(0)
  })

  test("an empty runRoot is a wiring bug, not a data problem — fails before any dispatch", async () => {
    const agent = stubAgent([])
    const result = await runWith(reviewDiff.run(INPUT), gitStub().service, agent.service, testRunInfo({ runRoot: "" }))

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ReviewRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  test("a run root that can't be written fails the diff write as ReviewDiffWriteFailed, before any dispatch", () =>
    withRunRoot(async (base) => {
      // `design/graph-node.test.ts`'s ENOTDIR trick: a real file sitting where a path component of
      // the run root needs to be a directory, cheaply reproducing the write-failure path without
      // mocking `FileSystem` itself. The diff write sits before the dispatch now, so an unwritable
      // run root is caught there — the stub agent records zero requests, and this failure costs
      // nothing because nothing was ever sent to a model.
      const blocker = join(base, "blocker")
      writeFileSync(blocker, "not a directory")
      const brokenRoot = join(blocker, "subdir")

      const agent = stubAgent([])
      const result = await runWith(reviewDiff.run(INPUT), gitStub().service, agent.service, testRunInfo({ runRoot: brokenRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewDiffWriteFailed)
      const failure = result.failure as ReviewDiffWriteFailed
      expect(failure.runRoot).toBe(brokenRoot)
      expect(failure.detail.length).toBeGreaterThan(0)
      expect(agent.requests).toHaveLength(0)
    }))

  test("the diff write can succeed and the findings write still fail on its own — ReviewFindingsWriteFailed, carrying the sessions already spent", async () => {
    // ENAMETOOLONG, calibrated the way `create/graph-node.test.ts`'s own scaffold test is: a
    // permission-bit trick would sail straight through a root-run suite (this one), so the failure
    // has to be structural. `runRoot` is built deep enough that appending the diff artifact's own
    // short filename (`diff-1.patch`, 12 chars) stays under this filesystem's PATH_MAX (probed: 4095
    // usable), but the findings artifact's four-longer prefix (`review-diff-1.md`, 16 chars) tips the
    // same write over it — reaching the findings write specifically, diff write already on disk,
    // which the ENOTDIR trick above can't do (an unwritable runRoot fails the diff write first).
    const topRoot = mkdtempSync(join(tmpdir(), "review-diff-node-"))
    // Usable path length (PATH_MAX minus the NUL) is 1023 on Darwin and 4095 on Linux, measured
    // against the resolved path: the root is realpath'd so a symlinked tmpdir (macOS's
    // /var -> /private/var) does not eat into the budget. The last stride is sized to land on target
    // rather than overshoot from a long macOS temp root. runRoot lands 15 under the limit: 13 more
    // for `/diff-1.patch` fits, 17 more for `/review-diff-1.md` does not.
    const USABLE = process.platform === "darwin" ? 1023 : 4095
    const target = USABLE - 65
    let deepRoot = realpathSync(topRoot)
    while (deepRoot.length < target) {
      deepRoot = join(deepRoot, "a".repeat(Math.min(200, target - deepRoot.length)))
      mkdirSync(deepRoot, { recursive: true })
    }
    deepRoot = join(deepRoot, "a".repeat(Math.max(1, USABLE - 15 - deepRoot.length - 1)))
    mkdirSync(deepRoot, { recursive: true })

    try {
      const agent = stubAgent([])
      const result = await runWith(reviewDiff.run(INPUT), gitStub().service, agent.service, testRunInfo({ runRoot: deepRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewFindingsWriteFailed)
      const failure = result.failure as ReviewFindingsWriteFailed
      expect(failure.runRoot).toBe(deepRoot)
      expect(failure.detail.length).toBeGreaterThan(0)
      expect(failure.sessions).toStrictEqual(["review-session"])
      expect(existsSync(`${deepRoot}/diff-1.patch`)).toBe(true)
    } finally {
      await removeDir(topRoot)
    }
  })

  // Pinned: two review-diff calls in one run journal-identically except for `headSha`. If that
  // field were ever narrowed or dropped from the journaled input, `replayableSuccess`
  // (`runtime/journal/service.ts`) would scan forward from a failed pass-1 attempt and find pass
  // 2's later `ok` row a match on every other field, replaying its clean verdict into pass 1's
  // slot — a resumed run reporting a tree clean that its own pass 1 never saw pass, silently. This
  // is the test that proves the field earns its place in the *input*, not only in the output: pass
  // 1 and pass 2 share one journal (one `testJournalLayer`, so they share one attempt counter, the
  // way one composite run's loop does), pass 1 blocks and pass 2 — a later call against a
  // different commit — comes back clean; a resumed run's own pass-1 request must re-run and block
  // again, not silently inherit pass 2's clean file.
  test("headSha in the journaled input stops a resumed pass 1 from replaying pass 2's clean verdict", () =>
    Effect.gen(function* () {
      const journalDir = mkdtempSync(join(tmpdir(), "review-diff-journal-"))
      const first = join(journalDir, "run-1.jsonl")
      const second = join(journalDir, "run-2.jsonl")
      const root1 = mkdtempSync(join(tmpdir(), "review-diff-node-"))
      const root2 = mkdtempSync(join(tmpdir(), "review-diff-node-"))
      const pass2Input = { ...INPUT, headSha: inputExamples[1]!.headSha }

      // One journal layer around both calls, so `journal.attempt("review-diff")` counts 1 then 2 —
      // the position `replayableSuccess` keys on — exactly as it would inside one composite run.
      yield* Effect.gen(function* () {
        yield* Effect.result(
          reviewDiff.run(INPUT).pipe(
            Effect.provide(shellLayer(gitStub().service)),
            Effect.provide(claudeAgentLayer(stubAgent(["still broken"]).service)),
            Effect.provideService(RunInfo, testRunInfo({ runRoot: root1 }))
          )
        )
        yield* Effect.result(
          reviewDiff.run(pass2Input).pipe(
            Effect.provide(shellLayer(gitStub({ head: pass2Input.headSha }).service)),
            Effect.provide(claudeAgentLayer(stubAgent([]).service)),
            Effect.provideService(RunInfo, testRunInfo({ runRoot: root1 }))
          )
        )
      }).pipe(Effect.provide(testJournalLayer({ path: first, predecessor: Option.none() })))

      const agent = stubAgent(["still broken"])
      const result = yield* Effect.result(
        reviewDiff.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path: second, predecessor: Option.some(first) })),
          Effect.provide(shellLayer(gitStub().service)),
          Effect.provide(claudeAgentLayer(agent.service)),
          Effect.provideService(RunInfo, testRunInfo({ runRoot: root2 }))
        )
      )

      expect(agent.requests).toHaveLength(1)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ReviewBlocked)
      expect(readFileSync((result.failure as ReviewBlocked).findingsPath, "utf8")).toContain("still broken")
    }).pipe(Effect.provide(platform), Effect.runPromise))
})
