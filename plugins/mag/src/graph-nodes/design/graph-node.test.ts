import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"
import { DesignCopyFailed, DesignFileMissing, DesignGitFailed, DesignRunRootMissing } from "mag/graph-nodes/design/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/design/examples"
import { design } from "mag/graph-nodes/design/graph-node"
import { UsageLimit } from "mag/runtime/claude/errors"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

const HEAD_SHA = "cccccccccccccccccccccccccccccccccccccccc"

/** `rev-parse HEAD` alone: under the default `run-root` policy, nothing else in `design` calls `Shell`. */
const shellStub = (reply: ShellResult = { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" }): ShellService => ({
  run: (argv) => {
    if (argv[1] === "rev-parse") return Effect.succeed(reply)
    throw new Error(`shellStub: unexpected argv ${argv.join(" ")}`)
  }
})

/** In-order scripted shell, `brainstorm/graph-node.test.ts`'s idiom, for the `records: "committed"` test. */
const scriptedCommitShell = (replies: readonly ShellResult[]) => {
  const calls: string[][] = []
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedCommitShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const okReply = (): ShellResult => ({ exitCode: 0, stdout: "", stderr: "" })
/** `git add` ok, `git diff --cached --quiet` exit 1 (staged), `git commit` ok, `git rev-parse HEAD` ok. */
const commitsCleanly = () =>
  scriptedCommitShell([okReply(), { exitCode: 1, stdout: "", stderr: "" }, okReply(), { exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" }])

/**
 * A stub agent that records the request and answers with a canned reply. `write` stands in for
 * the real session's brainstorming-skill write (the agent owns the artifact), fired inside `prompt`
 * so it lands between the node's before-dispatch snapshot and its after-dispatch read —
 * `envision-mermaid/graph-node.test.ts`'s own idiom, adopted here now that `design` takes the same
 * pre-dispatch snapshot: a test that pre-wrote the fixture before calling `runWith` would hand the
 * node an unchanged file and fail `DesignFileMissing` instead of proving success.
 */
const stubAgent = (write?: () => void) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      write?.()
      return Effect.succeed({
        verdict: { designPath: "docs/graph/GH-152/design.md" } as A,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0.31,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

const RUN = testRunInfo()

const INPUT = inputExamples[0]!

/**
 * `runPromise`, not `runSync`: `design` always provides `platform` internally (`graph-node.ts`),
 * and a real `FileSystem` read genuinely suspends the fiber.
 */
const runWith = <A, E>(
  effect: Effect.Effect<A, E, never>,
  agent: ClaudeAgentService,
  run = RUN,
  shell: ShellService = shellStub()
) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

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

/**
 * A real, disposable directory set standing in for the repo checkout, the run root, and the
 * separate `recordsRoot` a foreign run gets under the default `run-root` policy. All three are
 * real directories because the node's own `<runRoot>/design.md` copy (`records.ts`'s `record`) is
 * a real filesystem write wherever the record itself lands.
 */
const withDirs = async <T>(fn: (repoRoot: string, runRoot: string, recordsRoot: string) => Promise<T>): Promise<T> => {
  const base = mkdtempSync(join(tmpdir(), "design-node-"))
  const repoRoot = join(base, "repo")
  const runRoot = join(base, "run")
  const recordsRoot = join(base, "records")
  for (const dir of [repoRoot, runRoot, recordsRoot]) mkdirSync(dir, { recursive: true })
  try {
    return await fn(repoRoot, runRoot, recordsRoot)
  } finally {
    await removeDir(base)
  }
}

/** The design path a given root resolves to — read back without writing, for a test that needs it before the write callback fires. */
const designPathIn = (root: string, ticket: string): string => join(root, "docs", "graph", ticket, "design.md")

/** Stands in for the agent session's own write of the design (brainstorming skill, step 7). */
const writeDesign = (repoRoot: string, ticket: string, content: string): string => {
  const path = designPathIn(repoRoot, ticket)
  mkdirSync(join(repoRoot, "docs", "graph", ticket), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe("design", () => {
  test("the fixtures decode against design's own schemas", () => {
    if (!isSchemaHandle(design.input)) throw new Error("design.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(design.input)(example)
    if (!isSchemaHandle(design.success)) throw new Error("design.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(design.success)(example)
  })

  test("the prompt carries the ticket, the compiled brainstorming skill, and the exact repo destination — no override clause, no leftover token", async () => {
    // RUN's repoRoot is a fake path, so the post-session file check fails cleanly after the
    // dispatch — this test only cares about what was sent.
    const agent = stubAgent()
    await runWith(design.run(INPUT), agent.service)

    expect(agent.requests).toHaveLength(1)
    const request = agent.requests[0]!
    expect(request.cwd).toBe("/repo")
    expect(request.prompt).toContain(`Ticket ${INPUT.ticket}: ${INPUT.title}`)
    expect(request.prompt).toContain(INPUT.body)
    expect(request.prompt).toContain("brainstorming skill")
    expect(request.prompt).toContain(`docs/graph/${INPUT.ticket}/design.md`)
    expect(request.prompt).toContain("Confirm the design doc")
    // One destination, stated once: no override clause and no competing default.
    expect(request.prompt).not.toContain("not the skill's default location")
    expect(request.prompt).not.toContain("docs/plans/")
    // No leftover compile-time token: both are filled with the real ticket and skills root.
    expect(request.prompt).not.toContain("<TICKET>")
    expect(request.prompt).not.toContain("<SKILLS>")
  })

  test("the dispatched prompt carries autonomy's text and none of the three interactive concerns'", async () => {
    const agent = stubAgent()
    await runWith(design.run(INPUT), agent.service)

    const prompt = agent.requests[0]!.prompt
    expect(prompt).toContain("Do not wait for an approval nobody will give.")
    expect(prompt).not.toContain("<HARD-GATE>")
    expect(prompt).not.toContain("Ask clarifying questions")
    expect(prompt).not.toContain("Present design")
  })

  test("the input's agent reaches the dispatch verbatim; without one, none is sent", async () => {
    const bare = stubAgent()
    await runWith(design.run(INPUT), bare.service)
    expect(bare.requests[0]!.agent).toBeUndefined()

    const hardwired = stubAgent()
    await runWith(design.run(inputExamples[1]!), hardwired.service)
    expect(hardwired.requests[0]!.agent).toBe("effect-expert")
  })

  test("the input's model reaches the dispatch verbatim; without one, none is sent", async () => {
    const bare = stubAgent()
    await runWith(design.run(INPUT), bare.service)
    expect(bare.requests[0]!.model).toBeUndefined()

    const assigned = stubAgent()
    await runWith(design.run(inputExamples[1]!), assigned.service)
    expect(assigned.requests[0]!.model).toBe("opus")
  })

  test("the success carries the repo designPath, and the node copies the design into the run root", () =>
    withDirs(async (repoRoot, runRoot) => {
      const designPath = designPathIn(repoRoot, INPUT.ticket)
      const agent = stubAgent(() => writeDesign(repoRoot, INPUT.ticket, "Strip the NUL at the writer's boundary."))
      const run = testRunInfo({ repoRoot, workRoot: repoRoot, runRoot })
      const result = await runWith(design.run(INPUT), agent.service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        designPath,
        headSha: HEAD_SHA,
        sessions: ["stub-session"],
        costUsd: 0.31
      })
      expect(readFileSync(`${runRoot}/design.md`, "utf8")).toBe("Strip the NUL at the writer's boundary.")
    }))

  test("under records: \"committed\", a written design is also staged and committed at recordsDir, pathspec-scoped", () =>
    withDirs(async (repoRoot, runRoot) => {
      const designPath = designPathIn(repoRoot, INPUT.ticket)
      const agent = stubAgent(() => writeDesign(repoRoot, INPUT.ticket, "Strip the NUL at the writer's boundary."))
      const run = testRunInfo({ repoRoot, workRoot: repoRoot, runRoot, records: "committed" })
      const { calls, service: shell } = commitsCleanly()
      const result = await runWith(design.run(INPUT), agent.service, run, shell)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(readFileSync(`${runRoot}/design.md`, "utf8")).toBe("Strip the NUL at the writer's boundary.")
      expect(calls[0]).toStrictEqual(["git", "add", "--", designPath])
      expect(calls[2]).toStrictEqual(["git", "commit", "-m", `docs(${INPUT.ticket}): design\n\nThe design node reconciled the ticket into a design doc and committed it.\n\nClaude-Session: stub-session`, "--", designPath])
      expect(calls[3]).toStrictEqual(["git", "rev-parse", "HEAD"])
    }))

  test("under the default run-root policy, a written design makes no git call at all", () =>
    withDirs(async (repoRoot, runRoot) => {
      const agent = stubAgent(() => writeDesign(repoRoot, INPUT.ticket, "Strip the NUL at the writer's boundary."))
      const run = testRunInfo({ repoRoot, workRoot: repoRoot, runRoot })
      const { calls, service: shell } = commitsCleanly()
      const result = await runWith(design.run(INPUT), agent.service, run, shell)

      expect(Result.isSuccess(result)).toBe(true)
      // The final `rev-parse HEAD` still runs — headSha is read unconditionally — but no add/diff/commit does.
      expect(calls).toStrictEqual([["git", "rev-parse", "HEAD"]])
    }))

  // `design` is registry-only but still a dispatchable command (`registry.ts`), and its own prompt
  // composition (`skillFor`) substitutes this run's resolved records destination the same way `brainstorm`, the
  // live writer, does. Without that substitution a foreign run through `design` writes the compiled
  // skill's relative `DESIGN_DESTINATION` under dispatch cwd (`workRoot`, the target) and then fails
  // `DesignFileMissing` checking `recordsRoot`; this test is what holds the two lanes composing the
  // same way for a foreign run, not only for a home one.
  //
  // `headSha` reads at `workRoot`, never `recordsRoot`: under the default `run-root` policy,
  // `recordsRoot` is a plain OS temp directory with no git repository of its own
  // (`run-layers.ts`) — a real `git rev-parse HEAD` there fails `fatal: not a git repository`, three
  // paid sessions in. `workRoot` answers under every policy.
  test("a foreign run dispatches at workRoot, names the records path in the prompt, and reads headSha under workRoot", () =>
    withDirs(async (workRoot, runRoot, recordsRoot) => {
      const designPath = designPathIn(recordsRoot, INPUT.ticket)
      const agent = stubAgent(() => writeDesign(recordsRoot, INPUT.ticket, "Design lives under recordsRoot for a foreign run."))
      const cwds: Array<string | undefined> = []
      const shell: ShellService = {
        run: (argv, options) => {
          cwds.push(options?.cwd)
          return Effect.succeed({ exitCode: 0, stdout: `${HEAD_SHA}\n`, stderr: "" })
        }
      }
      const run = testRunInfo({ repoRoot: workRoot, workRoot, recordsRoot, runRoot })
      const result = await runWith(design.run(INPUT), agent.service, run, shell)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.designPath).toBe(designPath)
      expect(designPath.startsWith(recordsRoot)).toBe(true)
      expect(designPath.startsWith(workRoot)).toBe(false)

      const request = agent.requests[0]!
      expect(request.cwd).toBe(workRoot)
      // Without `skillFor`'s substitution, dispatch cwd (workRoot) plus the compiled skill's
      // relative DESIGN_DESTINATION would resolve inside the target instead of under `recordsRoot`.
      expect(request.prompt).toContain(designPath)
      // The confirm step is rewritten by the same substitution, so the session is told the
      // resolved records path is written — and, per `write-and-confirm.ts`'s own step, told the node
      // does the git work, not the session.
      expect(request.prompt).toContain(`the file at \`${designPath}\` is written and non-empty`)
      expect(request.prompt).toContain("do not run git")

      expect(cwds).toStrictEqual([workRoot])
    }))

  test("a failing rev-parse after a successful copy is DesignGitFailed, the copy itself untouched", () =>
    withDirs(async (repoRoot, runRoot) => {
      const agent = stubAgent(() => writeDesign(repoRoot, INPUT.ticket, "Strip the NUL at the writer's boundary."))
      const run = testRunInfo({ repoRoot, workRoot: repoRoot, runRoot })
      const failing = shellStub({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" })
      const result = await runWith(design.run(INPUT), agent.service, run, failing)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DesignGitFailed)
      expect((result.failure as DesignGitFailed).exitCode).toBe(128)
      expect(readFileSync(`${runRoot}/design.md`, "utf8")).toBe("Strip the NUL at the writer's boundary.")
    }))

  test("a session that never wrote the file is DesignFileMissing, carrying the path and the sessions spent", () =>
    withDirs(async (repoRoot, runRoot) => {
      const agent = stubAgent()
      const run = testRunInfo({ repoRoot, workRoot: repoRoot, runRoot })
      const result = await runWith(design.run(INPUT), agent.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DesignFileMissing)
      const failure = result.failure as DesignFileMissing
      expect(failure.path).toBe(`${repoRoot}/docs/graph/${INPUT.ticket}/design.md`)
      expect(failure.sessions).toStrictEqual(["stub-session"])
      expect(existsSync(`${runRoot}/design.md`)).toBe(false)
    }))

  test("a blank design file is DesignFileMissing too — nothing for build to start from", () =>
    withDirs(async (repoRoot, runRoot) => {
      writeDesign(repoRoot, INPUT.ticket, "  \n")
      const agent = stubAgent()
      const run = testRunInfo({ repoRoot, workRoot: repoRoot, runRoot })
      const result = await runWith(design.run(INPUT), agent.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DesignFileMissing)
    }))

  test("a design.md left over from a previous run, untouched by this session, is DesignFileMissing — a stale file is not this session's output", () =>
    withDirs(async (repoRoot, runRoot) => {
      // The stub agent never writes; a real session would overwrite in place, so this stands in for
      // a re-run whose session dispatched and produced nothing new (`brainstorm`'s own hole, closed
      // the same way here: `before` is read ahead of dispatch, so an unchanged file fails the same
      // as a missing one).
      writeDesign(repoRoot, INPUT.ticket, "Strip the NUL at the writer's boundary.")
      const agent = stubAgent()
      const run = testRunInfo({ repoRoot, workRoot: repoRoot, runRoot })
      const result = await runWith(design.run(INPUT), agent.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DesignFileMissing)
      expect(existsSync(`${runRoot}/design.md`)).toBe(false)
    }))

  test("a run root that can't be made is DesignCopyFailed, carrying the path, detail, and the sessions already spent", () =>
    withDirs(async (repoRoot, runRoot) => {
      // A real file sitting where a path component of the run root needs to be a directory: a
      // recursive `makeDirectory` under it fails ENOTDIR, cheaply reproducing the copy-failure
      // path without mocking `FileSystem` itself.
      const blocker = `${runRoot}/blocker`
      writeFileSync(blocker, "not a directory")
      const brokenRoot = `${blocker}/subdir`

      const agent = stubAgent(() => writeDesign(repoRoot, INPUT.ticket, "a design that never lands in the run root"))
      const run = testRunInfo({ repoRoot, workRoot: repoRoot, runRoot: brokenRoot })
      const result = await runWith(design.run(INPUT), agent.service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(DesignCopyFailed)
      const failure = result.failure as DesignCopyFailed
      expect(failure.path).toBe(`${brokenRoot}/design.md`)
      expect(failure.detail.length).toBeGreaterThan(0)
      expect(failure.sessions).toStrictEqual(["stub-session"])
    }))

  test("an empty runRoot is a wiring bug, not a data problem — fails before any dispatch", async () => {
    const agent = stubAgent()
    const run = testRunInfo({ runRoot: "" })
    const result = await runWith(design.run(INPUT), agent.service, run)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(DesignRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  test("a transport failure passes through untouched — the tag reaches the graph, not a wrapper", async () => {
    const limit = new UsageLimit({ resetAt: "2026-08-18T20:00:00Z", source: "api_retry", sessionId: "s" })
    const failing: ClaudeAgentService = { prompt: () => Effect.fail(limit) }
    const result = await runWith(design.run(INPUT), failing)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe(limit)
  })
})
