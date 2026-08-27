import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Option, Path, Result, Schema } from "effect"
import { inputExamples, successExamples } from "mag/graph-nodes/build-under-review/examples"
import { buildUnderReview } from "mag/graph-nodes/build-under-review/graph-node"
import {
  ReviewBlocked,
  ReviewDisputeRejected,
  ReviewGitFailed,
  ReviewHeadMoved
} from "mag/graph-nodes/review-diff/errors"
import { VerificationFailed } from "mag/graph-nodes/verification/errors"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellService, shellLayer } from "mag/runtime/shell"
import { testJournalLayer, testRunInfo } from "mag/test/node-fixture"

const SUITE = "bun run typecheck && bun run test"
const DIFF = "diff --git a/x.ts b/x.ts\n-old\n+new\n"

const INPUT = {
  ticket: "GH-98",
  title: "Fix the NUL-byte crash",
  body: "NUL bytes abort the run.",
  branch: "feat/GH-98-fix-the-nul-byte-crash",
  command: SUITE,
  base: "main",
  cap: 2
}

const ok = (stdout: string) => Effect.succeed({ exitCode: 0, stdout, stderr: "" })

/** One verification check's reply: a red one names a failing test, since a repair reads the report written from it. */
const suiteResult = (red: boolean) =>
  red ? Effect.succeed({ exitCode: 1, stdout: "", stderr: "FAIL: 1 test failed\n" }) : ok("42 pass\n")

/** Routing predicates shared by every fixture below — review and simplify are each keyed on their own dispatch's distinctive prompt text, build is whatever's left. */
const isReviewPrompt = (request: ClaudePrint<unknown>) => request.prompt.includes("reply with only the blocking findings")
const isSimplifyPrompt = (request: ClaudePrint<unknown>) =>
  request.prompt.includes("Reduce this diff to the same behaviour in less code")
const isBuildPrompt = (request: ClaudePrint<unknown>) => !isReviewPrompt(request) && !isSimplifyPrompt(request)

/**
 * One stub for every subprocess a loop pass makes, routed by argv shape — the graph tests' idiom.
 * `git rev-parse HEAD` walks a fixed sequence, advancing one step only when a commit truly lands —
 * signalled by a `rev-list --count` read, which `build` performs exactly once per pass, right after
 * its own commit. Every other read — the next pass's "before" baseline,
 * simplify's own head gate and post-commit re-read, and each review pass's own
 * head-gate — sees the current step until the next commit advances it, which is what makes a live
 * loop's head-gate pass: nothing moves `HEAD` between a build pass's own "after" read and the reads
 * that follow it. `git status --porcelain` always answers clean (build's own probes and
 * `simplify`'s guards alike), so `simplify` no-ops on every pass here by default — the shape
 * every test in this file except `simplifyCommitShell`'s two consumers wants. Two passes are the most
 * any test here drives, so three steps (initial, post-pass-1, post-pass-2) cover every caller.
 *
 * `isRed` decides which verification calls come back red; a repair build's own commit takes
 * the next `rev-list --count` slot, the same one a second pass would have used.
 */
const loopShell = (isRed: (call: number) => boolean = () => false) => {
  const calls: string[][] = []
  const shas = ["aaa111", "bbb222", "ccc333"]
  let index = 0
  let suiteCalls = 0
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const line = argv.join(" ")
      if (line === "git rev-parse HEAD") return ok(`${shas[index]}\n`)
      if (line === "git status --porcelain") return ok("") // every clean-tree probe in the loop
      if (line.startsWith("git rev-list --count")) {
        index += 1
        return ok("1\n")
      }
      if (line === `sh -c ${SUITE}`) return suiteResult(isRed((suiteCalls += 1)))
      if (line === "git diff main...HEAD") return ok(DIFF)
      // simplify's own changed-paths read — a real diff in every test here, since build
      // guarantees `commits > 0`, so the loop's own short-circuit can never fire.
      if (line === "git diff --name-only main...HEAD") return ok("x.ts\n")
      // review-diff's two governing-principles reads; no declared file here.
      if (line === "git diff --no-renames --name-only -z main...HEAD") return ok("")
      if (line === "git ls-files -z --full-name -- :/PRINCIPLES.md :/*/PRINCIPLES.md") return ok("")
      throw new Error(`loopShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

/**
 * A single-pass fixture where simplify's own session genuinely leaves the tree dirty, so its
 * mechanical commit fires and `HEAD` moves past whatever `build` produced — the shape the
 * sha-identity assertion and the `simplified: true` branch both need. `loopShell`'s default
 * (every probe clean, simplify always a no-op) can't produce this on purpose; a dedicated fixture
 * keeps that default simple for every other test in this file.
 *
 * `isRed` is the same shape as `loopShell`'s. The fourth sha is the one a repair's own commit takes, this
 * fixture already spending three on build's commit and simplify's own.
 */
const simplifyCommitShell = (isRed: (call: number) => boolean = () => false) => {
  const calls: string[][] = []
  const shas = ["aaa111", "bbb222", "ccc333", "ddd444"]
  let index = 0
  let suiteCalls = 0
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const line = argv.join(" ")
      if (line === "git rev-parse HEAD") return ok(`${shas[index]}\n`)
      if (line === "git status --porcelain") {
        // Ordinal 1-2 are build's own pair (pre-agent, its commitAgentLeftovers probe), ordinal 3 is
        // simplify's own pre-dispatch gate — all clean. Ordinal 4 is simplify's post-dispatch probe,
        // where its session's reduction is waiting to be staged.
        const ordinal = calls.filter((call) => call.join(" ") === "git status --porcelain").length
        return ok(ordinal === 4 ? "?? reduced.ts\n" : "")
      }
      if (line === "git add -A") return ok("")
      if (line === "git diff --cached --quiet") return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
      if (line.startsWith("git commit -m")) {
        index += 1
        return ok("")
      }
      if (line.startsWith("git rev-list --count")) {
        index += 1
        return ok("1\n")
      }
      if (line === `sh -c ${SUITE}`) return suiteResult(isRed((suiteCalls += 1)))
      if (line === "git diff main...HEAD") return ok(DIFF)
      if (line === "git diff --name-only main...HEAD") return ok("x.ts\n")
      if (line === "git diff --no-renames --name-only -z main...HEAD") return ok("")
      if (line === "git ls-files -z --full-name -- :/PRINCIPLES.md :/*/PRINCIPLES.md") return ok("")
      throw new Error(`simplifyCommitShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

/**
 * One stub for every agent dispatch, routed by which verdict the prompt asks for — review, then
 * simplify, then whatever's left is build. `blockingByReview` scripts each review pass's
 * findings in order; passes beyond the list come back clean.
 */
const loopAgent = (blockingByReview: readonly (readonly string[])[] = []) => {
  const requests: Array<ClaudePrint<unknown>> = []
  let builds = 0
  let reviews = 0
  let simplifies = 0
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      if (isReviewPrompt(request as ClaudePrint<unknown>)) {
        reviews += 1
        return Effect.succeed({
          verdict: { blocking: blockingByReview[reviews - 1] ?? [] } as A,
          result: {},
          sessions: [`session-review-${reviews}`],
          costUsd: 0.1,
          attempts: 1
        } as ClaudeReply<A>)
      }
      if (isSimplifyPrompt(request as ClaudePrint<unknown>)) {
        simplifies += 1
        return Effect.succeed({
          verdict: { note: "collapsed a duplicate helper" } as A,
          result: {},
          sessions: [`session-simplify-${simplifies}`],
          costUsd: 0.05,
          attempts: 1
        } as ClaudeReply<A>)
      }
      builds += 1
      return Effect.succeed({
        verdict: { summary: `build ${builds} summary` } as A,
        result: {},
        sessions: [`session-build-${builds}`],
        costUsd: 0.5,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/**
 * A fixed two-pass story purpose-built for the dispute edge — `loopShell`/`loopAgent` can't
 * produce a zero-commit pass (their `rev-list --count` reply is hardcoded to `1`). Pass 1 commits
 * (`aaa111` -> `bbb222`), runs simplify (a no-op: dispute edge behaviour is unaffected), then
 * review 1 blocks; pass 2 is a send-back that makes no commit and disputes instead (`bbb222..HEAD`
 * counts 0) — the dispute edge never reaches simplify or verification (`build` itself failed); the
 * adjudicating review then either accepts or blocks again, per `secondReviewBlocks`. `HEAD` only ever
 * advances once, at pass 1's own commit, then holds — every `rev-parse` after the first returns the
 * same sha, which is the mechanical fact a dispute asserts.
 */
const disputeShell = () => {
  const calls: string[][] = []
  let revParseCalls = 0
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const line = argv.join(" ")
      if (line === "git rev-parse HEAD") {
        revParseCalls += 1
        return ok(revParseCalls === 1 ? "aaa111\n" : "bbb222\n")
      }
      if (line === "git status --porcelain") return ok("") // every clean-tree probe
      if (line === "git rev-list --count aaa111..HEAD") return ok("1\n")
      if (line === "git rev-list --count bbb222..HEAD") return ok("0\n")
      if (line === `sh -c ${SUITE}`) return ok("42 pass\n")
      if (line === "git diff main...HEAD") return ok(DIFF)
      if (line === "git diff --name-only main...HEAD") return ok("x.ts\n")
      if (line === "git diff --no-renames --name-only -z main...HEAD") return ok("")
      if (line === "git ls-files -z --full-name -- :/PRINCIPLES.md :/*/PRINCIPLES.md") return ok("")
      throw new Error(`disputeShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

/**
 * Pass 1 builds and commits, runs simplify (a no-op), review 1 blocks; pass 2 disputes
 * instead of committing (no simplify, no verification on this edge), and the adjudicating review
 * either accepts (`secondReviewBlocks: false`) or blocks again — the deadlock this fixture models.
 */
const disputeAgent = (secondReviewBlocks: boolean) => {
  const requests: Array<ClaudePrint<unknown>> = []
  let builds = 0
  let reviews = 0
  let simplifies = 0
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      if (isReviewPrompt(request as ClaudePrint<unknown>)) {
        reviews += 1
        const blocking = reviews === 1
          ? ["the fix misses the second NUL"]
          : (secondReviewBlocks ? ["still not fixed"] : [])
        return Effect.succeed({
          verdict: { blocking } as A,
          result: {},
          sessions: [`session-review-${reviews}`],
          costUsd: 0.1,
          attempts: 1
        } as ClaudeReply<A>)
      }
      if (isSimplifyPrompt(request as ClaudePrint<unknown>)) {
        simplifies += 1
        return Effect.succeed({
          verdict: { note: "collapsed a duplicate helper" } as A,
          result: {},
          sessions: [`session-simplify-${simplifies}`],
          costUsd: 0.05,
          attempts: 1
        } as ClaudeReply<A>)
      }
      builds += 1
      const verdict = builds === 1
        ? { summary: "build 1 summary" }
        : { summary: "investigated, nothing to change", dispute: "both findings were already fixed at HEAD" }
      return Effect.succeed({
        verdict: verdict as A,
        result: {},
        sessions: [`session-build-${builds}`],
        costUsd: 0.5,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** Unlike `disputeShell`, every pass here commits, so a pass can commit *and* dispute. */
const committedDisputeShell = () => {
  const calls: string[][] = []
  const shas = ["aaa111", "bbb222", "ccc333", "ddd444"]
  let index = 0
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const line = argv.join(" ")
      if (line === "git rev-parse HEAD") return ok(`${shas[index]}\n`)
      if (line === "git status --porcelain") return ok("") // build's own mechanical-commit probe
      if (line.startsWith("git rev-list --count")) {
        index += 1
        return ok("1\n")
      }
      if (line === `sh -c ${SUITE}`) return ok("42 pass\n")
      if (line === "git diff main...HEAD") return ok(DIFF)
      // simplify's own changed-paths read — every pass here commits, so simplify dispatches too.
      if (line === "git diff --name-only main...HEAD") return ok("x.ts\n")
      if (line === "git diff --no-renames --name-only -z main...HEAD") return ok("")
      if (line === "git ls-files -z --full-name -- :/PRINCIPLES.md :/*/PRINCIPLES.md") return ok("")
      throw new Error(`committedDisputeShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

/** Pass 2 commits a fix for one finding and disputes another in the same reply. */
const committedDisputeAgent = (secondReviewBlocks: boolean, thirdReviewBlocks = false) => {
  const requests: Array<ClaudePrint<unknown>> = []
  let builds = 0
  let reviews = 0
  let simplifies = 0
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      if (request.prompt.includes("reply with only the blocking findings")) {
        reviews += 1
        const blocking = reviews === 1
          ? ["the fix misses the second NUL"]
          : reviews === 2
          ? (secondReviewBlocks ? ["still not fixed"] : [])
          : (thirdReviewBlocks ? ["still not fixed"] : [])
        return Effect.succeed({
          verdict: { blocking } as A,
          result: {},
          sessions: [`session-review-${reviews}`],
          costUsd: 0.1,
          attempts: 1
        } as ClaudeReply<A>)
      }
      if (isSimplifyPrompt(request as ClaudePrint<unknown>)) {
        simplifies += 1
        return Effect.succeed({
          verdict: { note: "collapsed a duplicate helper" } as A,
          result: {},
          sessions: [`session-simplify-${simplifies}`],
          costUsd: 0.05,
          attempts: 1
        } as ClaudeReply<A>)
      }
      builds += 1
      const verdict = builds === 1
        ? { summary: "build 1 summary" }
        : builds === 2
        ? { summary: "fixed one finding", dispute: "the other finding was already fixed at HEAD" }
        : { summary: "fixed the re-raised finding" }
      return Effect.succeed({
        verdict: verdict as A,
        result: {},
        sessions: [`session-build-${builds}`],
        costUsd: 0.5,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** A run root the artifact writes can actually land in, one fresh directory per test. */
const tempRunInfo = (overrides: Parameters<typeof testRunInfo>[0] = {}) =>
  testRunInfo({ runRoot: mkdtempSync(join(tmpdir(), "build-under-review-")), ...overrides })

const runNode = (
  input: Parameters<typeof buildUnderReview.run>[0],
  agent: ClaudeAgentService,
  shell: ShellService,
  runInfo = tempRunInfo()
) =>
  Effect.runPromise(
    Effect.result(
      buildUnderReview.run(input).pipe(
        Effect.provide(shellLayer(shell)),
        Effect.provide(claudeAgentLayer(agent)),
        Effect.provideService(RunInfo, runInfo)
      )
    )
  ).then((result) => ({ result, runInfo }))

describe("build-under-review", () => {
  test("the fixtures decode against the node's own schemas", () => {
    if (!isSchemaHandle(buildUnderReview.input)) throw new Error("input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(buildUnderReview.input)(example)
    if (!isSchemaHandle(buildUnderReview.success)) throw new Error("success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(buildUnderReview.success)(example)
  })

  test("wears the GraphNode shape, so the registry can run it with no graph runner", () => {
    expect(isSchemaHandle(buildUnderReview.input)).toBe(true)
    expect(isSchemaHandle(buildUnderReview.success)).toBe(true)
    expect(buildUnderReview.name).toBe("build-under-review")
  })

  test("cap: a negative value fails to decode — 'max send-backs' has no negative meaning", () => {
    const input = buildUnderReview.input
    if (!isSchemaHandle(input)) throw new Error("input is not a Schema")
    expect(() => Schema.decodeUnknownSync(input)({ ...INPUT, cap: -1 })).toThrow()
  })

  test("buildModel and reviewModel route to their own dispatch, independently, across both passes", async () => {
    const agent = loopAgent([["still broken"]])
    const { service } = loopShell()
    await runNode({ ...INPUT, buildModel: "sonnet", reviewModel: "opus" }, agent.service, service)

    const buildRequests = agent.requests.filter(isBuildPrompt)
    const reviewRequests = agent.requests.filter(isReviewPrompt)
    expect(buildRequests).toHaveLength(2)
    expect(reviewRequests).toHaveLength(2)
    for (const request of buildRequests) expect(request.model).toBe("sonnet")
    for (const request of reviewRequests) expect(request.model).toBe("opus")
  })

  test("without buildModel/reviewModel, no model is sent to either dispatch", async () => {
    const agent = loopAgent()
    const { service } = loopShell()
    await runNode(INPUT, agent.service, service)

    for (const request of agent.requests) expect(request.model).toBeUndefined()
  })

  test("a clean first pass: build, verify, simplify, review once, and fold the pass's whole spend", async () => {
    const agent = loopAgent()
    const { calls, service } = loopShell()
    const { result } = await runNode({ ...INPUT, designPath: "docs/graph/GH-98/design.md" }, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toMatchObject({
      commits: 1,
      reviewPasses: 1,
      costUsd: 0.65,
      sessions: ["session-build-1", "session-simplify-1", "session-review-1"]
    })

    // The first build works from the design; the reviewer stays blind to the build's own output.
    expect(agent.requests).toHaveLength(3)
    expect(agent.requests[0]!.prompt).toContain("Read the design at docs/graph/GH-98/design.md")
    const reviewRequest = agent.requests.find(isReviewPrompt)!
    expect(reviewRequest.prompt).not.toContain("build 1 summary")

    // Verification ran inside the pass, before the reviewer was dispatched — simplify's own commit
    // sequence sits between the two (a no-op here, so no `git add`/`git commit` calls at all).
    const verifyIndex = calls.findIndex((call) => call.join(" ") === `sh -c ${SUITE}`)
    const diffIndex = calls.findIndex((call) => call.join(" ") === "git diff main...HEAD")
    expect(verifyIndex).toBeGreaterThanOrEqual(0)
    expect(diffIndex).toBeGreaterThan(verifyIndex)
    for (const call of calls) {
      expect(call).not.toContain("add")
      expect(call).not.toContain("commit")
    }
  })

  test("a send-back: findings feed the next build, every review pass is a fresh session gated on its own build's headSha, spend folds every pass", async () => {
    const agent = loopAgent([["the fix misses the second NUL"]])
    const { service } = loopShell()
    const { result, runInfo } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toMatchObject({
      reviewPasses: 2,
      costUsd: 0.5 + 0.05 + 0.1 + 0.5 + 0.05 + 0.1,
      sessions: [
        "session-build-1",
        "session-simplify-1",
        "session-review-1",
        "session-build-2",
        "session-simplify-2",
        "session-review-2"
      ]
    })
    expect(result.success.summaryPath).toBe(join(runInfo.runRoot, "build-2.md"))

    const buildRequests = agent.requests.filter(isBuildPrompt)
    const reviewRequests = agent.requests.filter(isReviewPrompt)
    // simplify dispatches on every pass, not just the first.
    expect(agent.requests.filter(isSimplifyPrompt)).toHaveLength(2)

    // No design was passed, so the first build carries no addendum at all; the second carries
    // `findingsPath`, which build's own prompt
    // renders as the send-back block pointing at the findings file the reviewer wrote.
    expect(buildRequests[0]!.prompt).not.toContain("recorded at")
    expect(buildRequests[1]!.prompt).toContain(join(runInfo.runRoot, "review-diff-1.md"))
    expect(readFileSync(join(runInfo.runRoot, "review-diff-1.md"), "utf8")).toBe(
      "Reviewed at bbb222\n\n- the fix misses the second NUL"
    )

    // The send-back's next build pass resumes the session that produced the reviewed
    // head, the first pass carries none (nothing to resume yet).
    expect(buildRequests[0]!.resume).toBeUndefined()
    expect(buildRequests[1]!.resume).toBe("session-build-1")

    // No session is resumed across passes — each review is a fresh session over the
    // current diff, so there is no delta brief and no `resume` field to carry.
    expect(reviewRequests[0]!.resume).toBeUndefined()
    expect(reviewRequests[1]!.resume).toBeUndefined()
    expect(reviewRequests[1]!.prompt).not.toContain("Delta pass")

    // Each pass's review is stamped with that pass's own build headSha — pass 1 and pass 2
    // differ. Simplify no-ops here (the default fixture), so that sha is still build's own; the
    // test below proves the substitution when simplify actually commits.
    expect(readFileSync(join(runInfo.runRoot, "review-diff-1.md"), "utf8").split("\n")[0]).toBe("Reviewed at bbb222")
    expect(readFileSync(join(runInfo.runRoot, "review-diff-2.md"), "utf8").split("\n")[0]).toBe("Reviewed at ccc333")
  })

  test("a cap-spent loop refails the reviewer's own REVIEW_BLOCKED, findings still aboard", async () => {
    const agent = loopAgent([["still broken"], ["still broken"], ["still broken"]])
    const { service } = loopShell()
    const { result } = await runNode({ ...INPUT, cap: 1 }, agent.service, service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ReviewBlocked)
    // cap 1: two builds, two simplify passes (both no-ops), two reviews, then the second block ends
    // the loop.
    expect(agent.requests).toHaveLength(6)
  })

  // Call order is build -> verification -> simplify -> review-diff, and the sha
  // review-diff receives is simplify's own, not build's — a test that only asserted order would pass
  // a composite that reviewed the pre-simplify sha, which is the exact defect this test names.
  test("review-diff is gated on simplify's own headSha, not build's, and commits stays build's own count", async () => {
    const agent = loopAgent()
    const { calls, service } = simplifyCommitShell()
    const { result, runInfo } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    // The composite's own `commits` stays build's own count — it does not
    // absorb the simplify commit.
    expect(result.success.commits).toBe(1)

    const verifyIndex = calls.findIndex((call) => call.join(" ") === `sh -c ${SUITE}`)
    const addIndex = calls.findIndex((call) => call[0] === "git" && call[1] === "add" && call[2] === "-A")
    const reviewDiffIndex = calls.findIndex((call) => call.join(" ") === "git diff main...HEAD")
    expect(verifyIndex).toBeGreaterThanOrEqual(0)
    expect(addIndex).toBeGreaterThan(verifyIndex)
    expect(reviewDiffIndex).toBeGreaterThan(addIndex)

    // The mechanism: the reviewer's own findings file names the sha simplify's commit produced
    // (ccc333), not the sha build left off on (bbb222).
    expect(readFileSync(join(runInfo.runRoot, "review-diff-1.md"), "utf8").split("\n")[0]).toBe("Reviewed at ccc333")
  })

  // A reduction that moves HEAD triggers a second verification.run on the new sha.
  test("simplified: true issues a second verification.run", async () => {
    const agent = loopAgent()
    const { calls, service } = simplifyCommitShell()
    const { result } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    expect(calls.filter((call) => call.join(" ") === `sh -c ${SUITE}`)).toHaveLength(2)
  })

  // An unmoved tree (the ordinary no-op case) triggers no second verification.
  test("simplified: false issues no second verification", async () => {
    const agent = loopAgent()
    const { calls, service } = loopShell()
    const { result } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    expect(calls.filter((call) => call.join(" ") === `sh -c ${SUITE}`)).toHaveLength(1)
  })

  test("a send-back pass disputes, the adjudicating review passes, no verification or simplify ran on the dispute edge", async () => {
    const agent = disputeAgent(false)
    const { calls, service } = disputeShell()
    const { result, runInfo } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toMatchObject({
      commits: 0,
      reviewPasses: 2,
      disputePath: join(runInfo.runRoot, "dispute-1.md"),
      sessions: ["session-build-1", "session-simplify-1", "session-review-1", "session-build-2", "session-review-2"]
    })

    const buildRequests = agent.requests.filter(isBuildPrompt)
    const reviewRequests = agent.requests.filter(isReviewPrompt)
    // Build 2 received findingsPath (the send-back edge); review 2 — a fresh session with no memory
    // of review 1 — received both review 1's findings and build 2's dispute of them,
    // alongside build 2's own headSha, unchanged from what review 1 gated on.
    expect(buildRequests[1]!.prompt).toContain(join(runInfo.runRoot, "review-diff-1.md"))
    expect(reviewRequests[1]!.prompt).toContain(join(runInfo.runRoot, "review-diff-1.md"))
    expect(reviewRequests[1]!.prompt).toContain(join(runInfo.runRoot, "dispute-1.md"))

    // Simplify dispatched exactly once — pass 1's own; the dispute edge (pass 2) never reaches it.
    expect(agent.requests.filter(isSimplifyPrompt)).toHaveLength(1)

    // Verification ran exactly once — pass 1's own — never on the dispute edge (build 2 failed, so
    // the generator never reached that call).
    expect(calls.filter((call) => call.join(" ") === `sh -c ${SUITE}`)).toHaveLength(1)
  })

  test("an adjudicating pass that also blocks fails ReviewDisputeRejected, and no third build pass is dispatched", async () => {
    const agent = disputeAgent(true)
    const { service } = disputeShell()
    const { result } = await runNode(INPUT, agent.service, service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ReviewDisputeRejected)
    expect(result.failure._tag).not.toBe("REVIEW_BLOCKED")

    const buildRequests = agent.requests.filter(isBuildPrompt)
    expect(buildRequests).toHaveLength(2)
  })

  test("the settling case — review 2 accepts a committing pass's dispute, and the composite's own success carries disputePath", async () => {
    const agent = committedDisputeAgent(false)
    const { calls, service } = committedDisputeShell()
    const { result, runInfo } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toMatchObject({
      commits: 1,
      reviewPasses: 2,
      disputePath: join(runInfo.runRoot, "dispute-1.md")
    })

    // Unlike the zero-commit dispute edge, `verification` ran on pass 2 too — the tree moved.
    expect(calls.filter((call) => call.join(" ") === `sh -c ${SUITE}`)).toHaveLength(2)
  })

  test("the routing case — review 2 blocks the committing pass's dispute, and (cap permitting) a third build pass is dispatched carrying review 2's findings", async () => {
    const agent = committedDisputeAgent(true, false)
    const { service } = committedDisputeShell()
    const { result, runInfo } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return

    const buildRequests = agent.requests.filter(isBuildPrompt)
    expect(buildRequests).toHaveLength(3)
    expect(buildRequests[2]!.prompt).toContain(join(runInfo.runRoot, "review-diff-2.md"))
  })

  test("the cap-spent case — the same run with cap: 1 escalates ReviewDisputeRejected and dispatches no third build pass", async () => {
    const agent = committedDisputeAgent(true)
    const { service } = committedDisputeShell()
    const { result } = await runNode({ ...INPUT, cap: 1 }, agent.service, service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ReviewDisputeRejected)

    const buildRequests = agent.requests.filter(isBuildPrompt)
    expect(buildRequests).toHaveLength(2)
  })

  test("a red build head repairs by resuming the session that produced it, then reaches review", async () => {
    const agent = loopAgent()
    const { calls, service } = loopShell((call) => call === 1)
    const { result, runInfo } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return

    const buildRequests = agent.requests.filter(isBuildPrompt)
    expect(buildRequests).toHaveLength(2)
    // The repair resumes the session that produced the red head, not a fresh one — a fresh session
    // would re-derive intent instead of continuing the work that's already in progress.
    expect(buildRequests[1]!.resume).toBe("session-build-1")
    expect(buildRequests[1]!.prompt).toContain(join(runInfo.runRoot, "verification-1.txt"))
    expect(buildRequests[1]!.prompt).not.toContain(INPUT.body)

    // The repair's own commit rides the composite's own `commits` total,
    // 1 from the original pass, 1 from the repair.
    expect(result.success.commits).toBe(2)
    expect(calls.filter((call) => call.join(" ") === `sh -c ${SUITE}`)).toHaveLength(2)
    // Review dispatched exactly once, over the repaired (green) head, never over the red one.
    expect(agent.requests.filter(isReviewPrompt)).toHaveLength(1)
  })

  test("a repair that's still red at the cap refails VERIFICATION_FAILED, the last report on disk", async () => {
    const agent = loopAgent()
    // Every check red, forever: `simplify` and `review-diff` are never reached, `verified`
    // escalating before the loop's generator gets there.
    const { service } = loopShell(() => true)
    const { result, runInfo } = await runNode({ ...INPUT, cap: 1 }, agent.service, service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(VerificationFailed)
    const failure = result.failure as VerificationFailed
    // The second attempt's report, not the first's, the cap was spent on the repair the first
    // report paid for, and this failure is what that repair itself left behind.
    expect(failure.reportPath).toBe(join(runInfo.runRoot, "verification-2.txt"))
    expect(readFileSync(failure.reportPath, "utf8")).toContain("FAIL: 1 test failed")

    // One repair was spent: the original build plus the one resumed repair the cap allowed, no more.
    const buildRequests = agent.requests.filter(isBuildPrompt)
    expect(buildRequests).toHaveLength(2)
    expect(agent.requests.filter(isReviewPrompt)).toHaveLength(0)
  })

  test("a red simplify head repairs by resuming simplify's own session, through build", async () => {
    const agent = loopAgent()
    // Build's own head passes; simplify's reduction is red on its own check, the second.
    const { calls, service } = simplifyCommitShell((call) => call === 2)
    const { result, runInfo } = await runNode(INPUT, agent.service, service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return

    const buildRequests = agent.requests.filter(isBuildPrompt)
    expect(buildRequests).toHaveLength(2)
    // `simplify`'s own head is repaired too, but never by resuming `simplify` itself —
    // `simplify` is ticket-blind by design, so the repair is a `build` dispatch resuming the id
    // `simplify` returned.
    expect(buildRequests[1]!.resume).toBe("session-simplify-1")
    expect(buildRequests[1]!.prompt).toContain(join(runInfo.runRoot, "verification-1.txt"))

    expect(result.success.headSha).toBe("ddd444")
    // build's own commit (1) plus the repair's own commit (1), the repair rides the same head build's did.
    expect(result.success.commits).toBe(2)
    expect(calls.filter((call) => call.join(" ") === `sh -c ${SUITE}`)).toHaveLength(3)
    expect(agent.requests.filter(isReviewPrompt)).toHaveLength(1)
  })

  // The loop's tag check (`failure._tag !== "REVIEW_BLOCKED"`) only sends a review's own
  // blocking findings back to build. Any other tag from `reviewDiff.run` — the reviewer's transport
  // died, its git read failed — is not something a rebuilt diff can fix, so it must propagate at
  // once, spending neither the cap nor a second build.
  test("a non-blocking reviewer error ends the loop at once, unconsumed", async () => {
    const agent = loopAgent()
    const inner = loopShell()
    const service: ShellService = {
      run: (argv) => {
        const line = argv.join(" ")
        if (line === "git diff main...HEAD") {
          return Effect.succeed({ exitCode: 1, stdout: "", stderr: "fatal: bad revision 'main...HEAD'\n" })
        }
        return inner.service.run(argv)
      }
    }
    const { result } = await runNode(INPUT, agent.service, service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ReviewGitFailed)
    // Unconsumed: the build ran once and simplify ran once (its own read is a different argv,
    // unaffected by this override) — the reviewer's own transport failure ended the loop before its
    // own dispatch, so no second build and no second simplify pass.
    expect(agent.requests).toHaveLength(2)
  })

  // A stale verdict (recorded head sha != branch head being gated) must be mechanically
  // detectable as an error. Here the tree moves between simplify's own re-read and the review pass's
  // head-gate read of the same commit.
  test("a tree that moved between simplify and review fails ReviewHeadMoved out of the composite, with no further build pass dispatched", async () => {
    const agent = loopAgent()
    const inner = loopShell()
    let revParseCount = 0
    const service: ShellService = {
      run: (argv) => {
        const line = argv.join(" ")
        if (line === "git rev-parse HEAD") {
          revParseCount += 1
          // Calls 1-2 are build's own before/after pair for pass 1; calls 3-4 are simplify's own
          // head gate and its post-commit re-read (both unaffected — the tree hasn't moved
          // yet, and simplify is a no-op here); call 5 is review-diff's own head-gate, made to
          // disagree with what build and simplify both just measured.
          if (revParseCount === 5) return ok("moved-sha\n")
        }
        return inner.service.run(argv)
      }
    }
    const { result } = await runNode(INPUT, agent.service, service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ReviewHeadMoved)
    const buildRequests = agent.requests.filter(isBuildPrompt)
    expect(buildRequests).toHaveLength(1)
  })
})

/** Reads and parses every row of a journal file at `path`, in order. */
const readRows = (fs: FileSystem.FileSystem, path: string) =>
  Effect.map(fs.readFileString(path), (text) =>
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>))

/** Every journal test runs inside a scoped temp directory standing in for a run root. */
const inTempJournalDir = <A, E>(
  body: (paths: {
    readonly fs: FileSystem.FileSystem
    readonly journalFor: (runId: string) => string
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
): Promise<A> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped()
    const journalFor = (runId: string) => path.join(dir, `${runId}.jsonl`)
    return yield* body({ fs, journalFor })
  }).pipe(Effect.scoped, Effect.provide(platform), Effect.runPromise) as Promise<A>

/** The loop's node/event sequence for one clean pass — `simplify` sits between `verification` and `review-diff`, a position other tests depend on. */
const ONE_PASS_SEQUENCE = [
  ["build-under-review", "start"],
  ["build", "start"],
  ["build", "end"],
  ["verification", "start"],
  ["verification", "end"],
  ["simplify", "start"],
  ["simplify", "end"],
  ["review-diff", "start"],
  ["review-diff", "end"],
  ["build-under-review", "end"]
]

describe("build-under-review — journal", () => {
  test("a green run's journal opens on the composite's own start entry and closes on its end entry, the loop's pairs nested between", async () => {
    const rows = await inTempJournalDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const path = journalFor("run-1")
        const agent = loopAgent()
        const { service } = loopShell()

        yield* buildUnderReview.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path, predecessor: Option.none() })),
          Effect.provide(shellLayer(service)),
          Effect.provide(claudeAgentLayer(agent.service)),
          Effect.provideService(RunInfo, tempRunInfo())
        )

        return yield* readRows(fs, path)
      })
    )

    expect(rows.map((row) => [row["node"], row["event"]])).toStrictEqual(ONE_PASS_SEQUENCE)
  })

  test("a resume that recorded the composite's success replays the whole settled loop without re-running any part", async () => {
    const result = await inTempJournalDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")

        const original = { agent: loopAgent(), shell: loopShell() }
        yield* buildUnderReview.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path: first, predecessor: Option.none() })),
          Effect.provide(shellLayer(original.shell.service)),
          Effect.provide(claudeAgentLayer(original.agent.service)),
          Effect.provideService(RunInfo, tempRunInfo())
        )

        // A resume is a fresh process: stubs with nothing scripted, so any dispatch at all throws.
        const resumedShell: ShellService = {
          run: (argv) => {
            throw new Error(`resumed run must not call the shell: ${argv.join(" ")}`)
          }
        }
        const resumedAgent: ClaudeAgentService = {
          prompt: () => {
            throw new Error("resumed run must not dispatch an agent")
          }
        }
        const value = yield* buildUnderReview.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path: second, predecessor: Option.some(first) })),
          Effect.provide(shellLayer(resumedShell)),
          Effect.provide(claudeAgentLayer(resumedAgent)),
          Effect.provideService(RunInfo, tempRunInfo({ runId: "run-2" }))
        )

        return { value, secondRows: yield* readRows(fs, second) }
      })
    )

    expect(result.value).toMatchObject({ reviewPasses: 1, costUsd: 0.65 })
    expect(result.secondRows).toHaveLength(2)
    expect(result.secondRows[0]).toMatchObject({ node: "build-under-review", event: "start" })
    expect(result.secondRows[1]).toMatchObject({ node: "build-under-review", event: "end", replayed: true, outcome: "ok" })
  })

  test("a run that ends in an accepted dispute records BUILD_DISPUTED on build 2's end row, and disputePath in review 2's start-row input", async () => {
    const { value, rows } = await inTempJournalDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const path = journalFor("run-1")
        const agent = disputeAgent(false)
        const { service } = disputeShell()

        const runValue = yield* buildUnderReview.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path, predecessor: Option.none() })),
          Effect.provide(shellLayer(service)),
          Effect.provide(claudeAgentLayer(agent.service)),
          Effect.provideService(RunInfo, tempRunInfo())
        )

        return { value: runValue, rows: yield* readRows(fs, path) }
      })
    )

    expect(value.disputePath).toBeDefined()

    const buildEndRows = rows.filter((row) => row["node"] === "build" && row["event"] === "end")
    expect(buildEndRows).toHaveLength(2)
    expect(buildEndRows[0]).toMatchObject({ outcome: "ok" })
    expect(buildEndRows[1]).toMatchObject({ outcome: "fail", tag: "BUILD_DISPUTED" })

    const reviewStartRows = rows.filter((row) => row["node"] === "review-diff" && row["event"] === "start")
    expect(reviewStartRows).toHaveLength(2)
    const adjudicatingInput = reviewStartRows[1]!["input"] as Record<string, unknown>
    expect(typeof adjudicatingInput["disputePath"]).toBe("string")
    expect(typeof adjudicatingInput["findingsPath"]).toBe("string")

    // The dispute edge never dispatched verification or simplify: only pass 1's own start/end pairs
    // appear for each.
    expect(rows.filter((row) => row["node"] === "verification")).toHaveLength(2)
    expect(rows.filter((row) => row["node"] === "simplify")).toHaveLength(2)
  })

  test("a committing pass that commits fixes and disputes records an ordinary build 2 end row, and both paths in review 2's start-row input", async () => {
    const { value, rows } = await inTempJournalDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const path = journalFor("run-1")
        const agent = committedDisputeAgent(false)
        const { service } = committedDisputeShell()

        const runValue = yield* buildUnderReview.run(INPUT).pipe(
          Effect.provide(testJournalLayer({ path, predecessor: Option.none() })),
          Effect.provide(shellLayer(service)),
          Effect.provide(claudeAgentLayer(agent.service)),
          Effect.provideService(RunInfo, tempRunInfo())
        )

        return { value: runValue, rows: yield* readRows(fs, path) }
      })
    )

    expect(value.disputePath).toBeDefined()

    const buildEndRows = rows.filter((row) => row["node"] === "build" && row["event"] === "end")
    expect(buildEndRows).toHaveLength(2)
    // Unlike the zero-commit edge, this pass committed: an ordinary success, never BUILD_DISPUTED.
    expect(buildEndRows[1]).toMatchObject({ outcome: "ok" })
    const buildTwoSuccess = buildEndRows[1]!["success"] as Record<string, unknown>
    expect(typeof buildTwoSuccess["disputePath"]).toBe("string")
    expect(typeof buildTwoSuccess["findingsPath"]).toBe("string")

    const reviewStartRows = rows.filter((row) => row["node"] === "review-diff" && row["event"] === "start")
    expect(reviewStartRows).toHaveLength(2)
    const adjudicatingInput = reviewStartRows[1]!["input"] as Record<string, unknown>
    expect(typeof adjudicatingInput["disputePath"]).toBe("string")
    expect(typeof adjudicatingInput["findingsPath"]).toBe("string")

    // This edge's tree moved (`build` succeeded, so `verification` ran), unlike the zero-commit dispute edge.
    expect(rows.filter((row) => row["node"] === "verification")).toHaveLength(4)
  })

  /**
   * Resuming a run that needed a send-back cannot land cleanly, and this test pins that as
   * the intentional, documented consequence it is, not a bug.
   *
   * Run-1 blocks on both passes and spends its cap. `build`'s row for pass 1 is a genuine `ok`, so
   * run-2 replays it — as does `verification`'s and `simplify`'s, both genuine `ok` rows
   * too. Pass 1's *review* is not: it blocked, never recorded a success, so it is not eligible to
   * replay and re-runs. But by the time run-2 starts, run-1's own pass 2 has already committed for
   * real, on the SAME checkout a resume shares with the run it resumes (one `loopShell()` instance
   * below, not one per "process" — `HEAD` only ever advances, the way a real git tree does, never
   * resets between separate invocations of the same process family). Pass 1's re-run review-gate
   * reads that live `HEAD`, finds it past the sha the replayed rows still carry, and fails
   * `ReviewHeadMoved` before any session is dispatched — the map (pass 1's cached sha) disagreeing
   * with the territory (what pass 2 already landed), caught mechanically.
   *
   * Both runs therefore share one sha sequence: giving each its own, restarting from run-1's
   * pass-1 sha, would be a state git does not produce without a reset, and would hide this exact
   * interaction. That a `{ command }`-only `verification` input makes every call journal-identical
   * stays pinned independently, at the node level (`verification/graph-node.test.ts`'s "headSha is
   * required" test) — not dependent on reaching a second loop pass.
   */
  test("a run resumed after a send-back fails ReviewHeadMoved — a replayed pass-1 build's sha cannot outrun the checkout pass 2 already advanced", async () => {
    const result = await inTempJournalDir(({ fs, journalFor }) =>
      Effect.gen(function* () {
        const first = journalFor("run-1")
        const second = journalFor("run-2")
        // One checkout, shared by both runs below — a resume reads the same tree the run it
        // resumes left behind, not a fresh one.
        const shell = loopShell()

        const run1 = yield* Effect.result(
          buildUnderReview.run({ ...INPUT, cap: 1 }).pipe(
            Effect.provide(testJournalLayer({ path: first, predecessor: Option.none() })),
            Effect.provide(shellLayer(shell.service)),
            Effect.provide(claudeAgentLayer(loopAgent([["still broken"], ["still broken"]]).service)),
            Effect.provideService(RunInfo, tempRunInfo())
          )
        )

        const resumedAgent = loopAgent()
        const value = yield* Effect.result(
          buildUnderReview.run({ ...INPUT, cap: 1 }).pipe(
            Effect.provide(testJournalLayer({ path: second, predecessor: Option.some(first) })),
            Effect.provide(shellLayer(shell.service)),
            Effect.provide(claudeAgentLayer(resumedAgent.service)),
            Effect.provideService(RunInfo, tempRunInfo({ runId: "run-2" }))
          )
        )

        return { run1, value, secondRows: yield* readRows(fs, second), resumedRequests: resumedAgent.requests }
      })
    )

    expect(Result.isFailure(result.run1)).toBe(true)
    if (Result.isFailure(result.run1)) expect(result.run1.failure).toBeInstanceOf(ReviewBlocked)

    expect(Result.isFailure(result.value)).toBe(true)
    if (!Result.isFailure(result.value)) return
    expect(result.value.failure).toBeInstanceOf(ReviewHeadMoved)
    const moved = result.value.failure as ReviewHeadMoved
    expect(moved.expected).toBe("bbb222") // pass 1's own build sha, replayed from run-1's journal
    expect(moved.observed).toBe("ccc333") // the live checkout: pass 2's build already landed here

    // Pass 1's build, verification and simplify all replayed; pass 1's review re-ran and failed at
    // its own gate before any session — build, simplify or review — was ever dispatched in run-2.
    expect(result.resumedRequests).toHaveLength(0)
    expect(result.secondRows.map((row) => [row["node"], row["event"]])).toStrictEqual(ONE_PASS_SEQUENCE)
  })
})
