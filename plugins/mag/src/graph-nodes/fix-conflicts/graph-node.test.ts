import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"
import {
  FixCommitFailed,
  FixConflictMarkersLeft,
  FixConflictsUnresolved,
  FixGitFailed,
  FixMergeStartFailed,
  FixMergeWithoutConflict,
  FixRunRootMissing,
  FixSummaryEmpty,
  FixWorkdirDirty
} from "mag/graph-nodes/fix-conflicts/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/fix-conflicts/examples"
import { commitMerge, fixConflicts } from "mag/graph-nodes/fix-conflicts/graph-node"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { liveShell, type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

/** In-order scripted shell, `build`'s own idiom. */
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
const exit = (exitCode: number, stdout = "", stderr = ""): ShellResult => ({ exitCode, stdout, stderr })

/** The happy-path sequence up through the resolver dispatch: clean guard, a real conflict, one unmerged path. */
const cleanAndConflicted: readonly ShellResult[] = [out(""), exit(1), out("f.txt\0")]

/** The happy-path sequence from just after the dispatch: resolved, staged, checked clean, tree computed, not committed. */
const resolvedAndStaged: readonly ShellResult[] = [
  out(""), // re-check: no unmerged entries left
  out(""), // git add -A
  exit(0), // git diff --cached --check: no markers
  out("bbb999\n") // git write-tree
]

const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({
        verdict: { summary: "resolved f.txt by keeping both sides' additions" } as A,
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

const removeDir = (path: string): Promise<void> => {
  if (!path.startsWith(tmpdir())) throw new Error(`removeDir: refusing to delete outside tmpdir: ${path}`)
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(path, { recursive: true })
    }).pipe(Effect.provide(platform))
  )
}

const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "fix-conflicts-node-"))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

const RUN = testRunInfo({ workRoot: "/work" })

const INPUT = inputExamples[0]!

const runWith = (
  effect: Effect.Effect<unknown, unknown, never>,
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

describe("fix-conflicts", () => {
  test("the fixtures decode against fix-conflicts's own schemas", () => {
    if (!isSchemaHandle(fixConflicts.input)) throw new Error("fixConflicts.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(fixConflicts.input)(example)
    if (!isSchemaHandle(fixConflicts.success)) throw new Error("fixConflicts.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(fixConflicts.success)(example)
  })

  // The bug this schema exists to prevent: a `{ target, targetSha }`-only input makes a replay
  // journal-identical to a run against a stale base once `main` has advanced (`verification`'s
  // `headSha` precedent).
  test("baseSha is required — a caller with no base tip to offer fails to decode, not silently drops the field", () => {
    const input = fixConflicts.input
    if (!isSchemaHandle(input)) throw new Error("fixConflicts.input is not a Schema")
    expect(() =>
      Schema.decodeUnknownSync(input)({
        base: "main",
        target: "feat/gh-184-fix",
        targetSha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3"
      })
    ).toThrow()
  })

  test("the resolver dispatch carries the declared agent and model, spliced from input", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([...cleanAndConflicted, ...resolvedAndStaged])
      const stub = stubAgent()
      const result = await runWith(fixConflicts.run(inputExamples[1]!), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      expect(stub.requests).toHaveLength(1)
      const request = stub.requests[0]!
      expect(request.agent).toBe("merge-conflict-resolver")
      expect(request.model).toBe("opus")
      expect(request.cwd).toBe("/work")
      expect(request.prompt).toContain("f.txt")
      expect(request.prompt).toContain("Do not run `git commit`, `git merge --abort`, or `git reset`")
    }))

  test("a resolved conflict succeeds, stages, and reports the live unmerged set as `paths` and the staged tree's own id", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([...cleanAndConflicted, ...resolvedAndStaged])
      const stub = stubAgent()
      const result = await runWith(fixConflicts.run(INPUT), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toMatchObject({ paths: ["f.txt"], treeSha: "bbb999", sessions: ["stub-session"], costUsd: 0.42 })
      expect(calls.map((call) => call.argv)).toStrictEqual([
        ["git", "status", "--porcelain"],
        ["git", "merge", "--no-commit", "--no-ff", "main"],
        ["git", "diff", "--name-only", "--diff-filter=U", "-z"],
        ["git", "diff", "--name-only", "--diff-filter=U", "-z"],
        ["git", "add", "-A"],
        ["git", "diff", "--cached", "--check"],
        ["git", "write-tree"]
      ])
      expect(calls.every((call) => call.cwd === "/work")).toBe(true)
      // Nothing here commits — `git commit` never appears in this node's own call log.
      expect(calls.map((call) => call.argv[1])).not.toContain("commit")
    }))

  test("an empty runRoot fails FixRunRootMissing before any git call or agent spend", () => {
    const stub = stubAgent()
    return runWith(fixConflicts.run(INPUT), scriptedShell([]).service, stub.service, testRunInfo({ workRoot: "/work", runRoot: "" })).then(
      (result) => {
        expect(Result.isFailure(result)).toBe(true)
        if (!Result.isFailure(result)) return
        expect(result.failure).toBeInstanceOf(FixRunRootMissing)
        expect(stub.requests).toHaveLength(0)
      }
    )
  })

  test("a dirty tree fails FixWorkdirDirty before the merge or any agent spend", () => {
    const { calls, service } = scriptedShell([{ exitCode: 0, stdout: " M other.ts\n", stderr: "" }])
    const stub = stubAgent()
    return runWith(fixConflicts.run(INPUT), service, stub.service).then((result) => {
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new FixWorkdirDirty({ paths: ["other.ts"] }))
      expect(calls).toHaveLength(1)
      expect(stub.requests).toHaveLength(0)
    })
  })

  test("a non-zero `git status` exit fails FixGitFailed, never read as clean", () => {
    const { service } = scriptedShell([exit(128, "", "fatal: not a git repository\n")])
    return runWith(fixConflicts.run(INPUT), service, stubAgent().service).then((result) => {
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(FixGitFailed)
    })
  })

  test("`git merge` exiting 0 fails FixMergeWithoutConflict — detection said conflict, the tree disagrees", () => {
    const { service } = scriptedShell([out(""), exit(0)])
    return runWith(fixConflicts.run(INPUT), service, stubAgent().service).then((result) => {
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new FixMergeWithoutConflict({ base: "main", target: "feat/gh-184-fix" }))
    })
  })

  test("`git merge` exiting neither 0 nor 1 fails FixMergeStartFailed", () => {
    const stderr = "fatal: refusing to merge unrelated histories\n"
    const { service } = scriptedShell([out(""), exit(128, "", stderr)])
    return runWith(fixConflicts.run(INPUT), service, stubAgent().service).then((result) => {
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(FixMergeStartFailed)
      expect((result.failure as FixMergeStartFailed).exitCode).toBe(128)
    })
  })

  test("an empty resolver summary fails FixSummaryEmpty, no artifact written", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([...cleanAndConflicted])
      const stub = stubAgent({ verdict: { summary: "   " } })
      const result = await runWith(fixConflicts.run(INPUT), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new FixSummaryEmpty({ sessions: ["stub-session"] }))
    }))

  test("unmerged entries surviving the session fail FixConflictsUnresolved carrying what remains", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([...cleanAndConflicted, out("f.txt\0")])
      const stub = stubAgent()
      const result = await runWith(fixConflicts.run(INPUT), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new FixConflictsUnresolved({ paths: ["f.txt"] }))
    }))

  test("`git diff --cached --check` exiting neither 0 nor 2 fails FixGitFailed, never read as marker-free", () =>
    withRunRoot(async (runRoot) => {
      const { service } = scriptedShell([...cleanAndConflicted, out(""), out(""), exit(129, "", "usage: git diff\n")])
      const stub = stubAgent()
      const result = await runWith(fixConflicts.run(INPUT), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(
        new FixGitFailed({ argv: "git diff --cached --check", exitCode: 129, stderr: "usage: git diff" })
      )
    }))

  test("leftover conflict markers on the staged tree fail FixConflictMarkersLeft — checked after `git add -A`, not before", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([...cleanAndConflicted, out(""), out(""), exit(2, "f.txt:1: leftover conflict marker\n")])
      const stub = stubAgent()
      const result = await runWith(fixConflicts.run(INPUT), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new FixConflictMarkersLeft({ detail: "f.txt:1: leftover conflict marker" }))
      // `git add -A` runs before the check that would fail on its output: the check has to see the
      // tree exactly as staged, or a marker reintroduced after the resolver's own staging would
      // reach the eventual commit unchecked.
      expect(calls.map((call) => call.argv.join(" "))).toStrictEqual([
        "git status --porcelain",
        "git merge --no-commit --no-ff main",
        "git diff --name-only --diff-filter=U -z",
        "git diff --name-only --diff-filter=U -z",
        "git add -A",
        "git diff --cached --check"
      ])
    }))

  test("a whitespace-only violation in `--cached --check` does not fail — only a leftover-marker line does (probed, git 2.53.0)", () =>
    withRunRoot(async (runRoot) => {
      const whitespaceOnly = "f.txt:2: trailing whitespace.\n+second line \n"
      const { service } = scriptedShell([
        ...cleanAndConflicted,
        out(""), // unmerged: resolved
        out(""), // git add -A
        exit(2, whitespaceOnly), // --check: non-zero, but no marker line in it
        out("bbb999\n") // git write-tree
      ])
      const stub = stubAgent()
      const result = await runWith(fixConflicts.run(INPUT), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
    }))

  test("a rejected `git add -A` fails FixCommitFailed carrying stderr and the session ids", () =>
    withRunRoot(async (runRoot) => {
      const stderr = "fatal: unable to write new index file\n"
      const { service } = scriptedShell([...cleanAndConflicted, out(""), exit(1, "", stderr)])
      const stub = stubAgent()
      const result = await runWith(fixConflicts.run(INPUT), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(FixCommitFailed)
      const failure = result.failure as FixCommitFailed
      expect(failure.argv).toBe("git add -A")
      expect(failure.stderr).toBe(stderr.trim())
      expect(failure.sessions).toStrictEqual(["stub-session"])
    }))

  test("on any failure past the merge, no `merge --abort` or `reset` ever appears in the call log", () =>
    withRunRoot(async (runRoot) => {
      const { calls, service } = scriptedShell([...cleanAndConflicted, out("f.txt\0")])
      const stub = stubAgent()
      await runWith(fixConflicts.run(INPUT), service, stub.service, testRunInfo({ workRoot: "/work", runRoot }))

      for (const call of calls) {
        expect(call.argv).not.toContain("abort")
        expect(call.argv).not.toContain("reset")
        expect(call.argv).not.toContain("stash")
      }
    }))
})

/**
 * `commitMerge` finishes what `fix-conflicts` staged, once `resolve-conflicts` has verified it — the
 * only caller. Its own small suite, since it is a plain exported function, not a `make()`-wrapped
 * node: `graph-node.test.ts` is its owned sibling, the same as any other helper `fix-conflicts`
 * exports (`conformance`'s `extra-file-ownership` rule).
 */
describe("commitMerge", () => {
  test("commits the staged merge and measures the resulting HEAD", () => {
    const { calls, service } = scriptedShell([out(""), out("eee555\n")])
    return Effect.runPromise(
      Effect.result(commitMerge("/work", "main", "feat/gh-184-fix", ["stub-session"]).pipe(Effect.provide(shellLayer(service))))
    ).then((result) => {
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ headSha: "eee555" })
      expect(calls[0]?.argv).toStrictEqual([
        "git",
        "commit",
        "-m",
        "Merge main into feat/gh-184-fix\n\nConflicts resolved by the fix-conflicts node's resolver session.\n\nClaude-Session: stub-session"
      ])
      expect(calls[1]?.argv).toStrictEqual(["git", "rev-parse", "HEAD"])
      expect(calls.every((call) => call.cwd === "/work")).toBe(true)
    })
  })

  test("a staged tree equal to HEAD still commits — resolving every conflict in favour of one side is not a vanished resolution (probed)", () => {
    // No `git diff --cached --quiet` guard anywhere in this call log: an index equal to HEAD is a
    // legitimate merge outcome here, not a failure to detect.
    const { calls, service } = scriptedShell([out(""), out("eee555\n")])
    return Effect.runPromise(
      Effect.result(commitMerge("/work", "main", "feat/gh-184-fix", ["stub-session"]).pipe(Effect.provide(shellLayer(service))))
    ).then((result) => {
      expect(Result.isSuccess(result)).toBe(true)
      expect(calls.map((call) => call.argv.join(" "))).not.toContain("git diff --cached --quiet")
    })
  })

  test("a rejected `git commit` fails FixCommitFailed carrying stderr and the session ids", () => {
    const stderr = "fatal: empty ident name\n"
    const { service } = scriptedShell([exit(1, "", stderr)])
    return Effect.runPromise(
      Effect.result(commitMerge("/work", "main", "feat/gh-184-fix", ["stub-session"]).pipe(Effect.provide(shellLayer(service))))
    ).then((result) => {
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(FixCommitFailed)
      const failure = result.failure as FixCommitFailed
      expect(failure.argv).toBe("git commit -m <message>")
      expect(failure.stderr).toBe("fatal: empty ident name")
      expect(failure.sessions).toStrictEqual(["stub-session"])
    })
  })

  test("a `rev-parse HEAD` failure after a successful commit fails FixGitFailed", () => {
    const { service } = scriptedShell([out(""), exit(128, "", "fatal: needed a single revision\n")])
    return Effect.runPromise(
      Effect.result(commitMerge("/work", "main", "feat/gh-184-fix", ["stub-session"]).pipe(Effect.provide(shellLayer(service))))
    ).then((result) => {
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(FixGitFailed)
    })
  })
})

/**
 * Real-git regression coverage: a stubbed shell proves only that this node formats argv, not that
 * git answers as the design claims — the stage/check ordering, the quiet-exit misread and
 * the whitespace false-positive would all be invisible to a scripted-shell suite that baked the
 * wrong assumption in as its own happy path. These tests run the node against real `liveShell`, in a
 * real temp repo, with a genuine merge conflict.
 */
describe("fix-conflicts, real git (a scripted shell cannot prove git's own semantics)", () => {
  const git = (cwd: string, args: readonly string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" })

  /**
   * A real repo with `target` checked out and diverged from `main` in `f.txt`, no merge started yet
   * — `fix-conflicts` itself runs `git merge --no-commit --no-ff main` as the first thing its own
   * `run` does, so the fixture must not start one, or the node's own dirty-workdir guard — which
   * runs before that merge — would see the fixture's own merge as pre-existing dirt and fail
   * `FixWorkdirDirty` before this node ever gets to do its own work.
   */
  const divergedRepo = (
    baseContent: string,
    targetContent: string
  ): { readonly repo: string; readonly baseSha: string; readonly targetSha: string } => {
    const repo = mkdtempSync(join(tmpdir(), "fix-conflicts-real-git-"))
    git(repo, ["init", "-q", "-b", "main"])
    git(repo, ["config", "user.email", "a@b.c"])
    git(repo, ["config", "user.name", "a"])
    writeFileSync(join(repo, "f.txt"), "line1\n")
    git(repo, ["add", "f.txt"])
    git(repo, ["commit", "-qm", "base"])
    git(repo, ["checkout", "-q", "-b", "target"])
    writeFileSync(join(repo, "f.txt"), targetContent)
    git(repo, ["commit", "-qam", "target"])
    git(repo, ["checkout", "-q", "main"])
    writeFileSync(join(repo, "f.txt"), baseContent)
    git(repo, ["commit", "-qam", "base2"])
    git(repo, ["checkout", "-q", "target"])
    const baseSha = git(repo, ["rev-parse", "main"]).trim()
    const targetSha = git(repo, ["rev-parse", "target"]).trim()
    return { repo, baseSha, targetSha }
  }

  const withDivergedRepo = async <T>(
    baseContent: string,
    targetContent: string,
    fn: (repo: string, baseSha: string, targetSha: string) => Promise<T>
  ): Promise<T> => {
    const { repo, baseSha, targetSha } = divergedRepo(baseContent, targetContent)
    try {
      return await fn(repo, baseSha, targetSha)
    } finally {
      await removeDir(repo)
    }
  }

  /** A ClaudeAgent stub that performs a real resolution against the repo, the way the actual resolver would. */
  const realResolver = (resolve: (repo: string) => void): ClaudeAgentService => ({
    prompt: <A>(request: ClaudePrint<A>) => {
      resolve(request.cwd!)
      return Effect.succeed({
        verdict: { summary: "resolved f.txt" } as A,
        result: {},
        sessions: ["real-git-session"],
        costUsd: 0.1,
        attempts: 1
      } as ClaudeReply<A>)
    }
  })

  const runReal = (repo: string, baseSha: string, targetSha: string, agent: ClaudeAgentService, runRoot: string) =>
    Effect.runPromise(
      Effect.result(
        fixConflicts.run({ base: "main", target: "target", baseSha, targetSha }).pipe(
          Effect.provide(Layer.mergeAll(shellLayer(liveShell), claudeAgentLayer(agent))),
          Effect.provideService(RunInfo, testRunInfo({ workRoot: repo, runRoot }))
        )
      )
    )

  /** Finishes what `runReal` staged, the same way `resolve-conflicts` does once verification is green. */
  const runCommit = (repo: string, sessions: readonly string[]) =>
    Effect.runPromise(
      Effect.result(commitMerge(repo, "main", "target", sessions).pipe(Effect.provide(shellLayer(liveShell))))
    )

  test("a genuine conflict stages cleanly, and commitMerge finishes it with no markers and two parents", () =>
    withRunRoot((runRoot) =>
      withDivergedRepo("base change\n", "target change\n", async (repo, baseSha, targetSha) => {
        const agent = realResolver((cwd) => {
          writeFileSync(join(cwd, "f.txt"), "resolved: both changes kept\n")
          git(cwd, ["add", "f.txt"])
        })
        const fixed = await runReal(repo, baseSha, targetSha, agent, runRoot)

        expect(Result.isSuccess(fixed)).toBe(true)
        if (!Result.isSuccess(fixed)) return
        // Staged, not committed: `target`'s HEAD hasn't moved yet.
        expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(targetSha)

        const committed = await runCommit(repo, fixed.success.sessions)
        expect(Result.isSuccess(committed)).toBe(true)
        expect(git(repo, ["show", "HEAD:f.txt"])).toBe("resolved: both changes kept\n")
        // `--count` and `--parents` don't compose (probed: `--count` suppresses the parents list
        // entirely and prints only a number) — plain `--parents -1` prints "<sha> <parent1> <parent2>".
        expect(git(repo, ["rev-list", "--parents", "-1", "HEAD"]).trim().split(" ")).toHaveLength(3) // sha + 2 parents
        expect(git(repo, ["status", "--porcelain"])).toBe("")
      })))

  test("a marker reintroduced into the working tree after the resolver's own staging still fails the fix", () =>
    withRunRoot((runRoot) =>
      withDivergedRepo("base change\n", "target change\n", async (repo, baseSha, targetSha) => {
        const agent = realResolver((cwd) => {
          // The resolver stages a clean resolution, exactly as its brief instructs...
          writeFileSync(join(cwd, "f.txt"), "clean resolution\n")
          git(cwd, ["add", "f.txt"])
          // ...but the working tree is then left with markers again (a late edit, a bad tool run).
          // Checking `--cached` before this node's own `git add -A` would miss this: only the
          // earlier, already-staged clean version was ever inspected.
          writeFileSync(join(cwd, "f.txt"), "<<<<<<< HEAD\nclean resolution\n=======\nsomething\n>>>>>>> main\n")
        })
        const result = await runReal(repo, baseSha, targetSha, agent, runRoot)

        expect(Result.isFailure(result)).toBe(true)
        if (!Result.isFailure(result)) return
        expect(result.failure).toBeInstanceOf(FixConflictMarkersLeft)
        const failure = result.failure as FixConflictMarkersLeft
        expect(failure.detail).toContain("leftover conflict marker")
        // The merge is left open for a human, per this node's own no-repair rule.
        expect(git(repo, ["status", "--porcelain"])).not.toBe("")
      })))

  test("a trailing-whitespace line unrelated to the conflict does not fail the fix", () =>
    withRunRoot((runRoot) =>
      // Base carries its own pre-existing trailing whitespace, nothing to do with the resolver.
      withDivergedRepo("base change \n", "target change\n", async (repo, baseSha, targetSha) => {
        const agent = realResolver((cwd) => {
          // Resolved content keeps base's trailing-whitespace line verbatim.
          writeFileSync(join(cwd, "f.txt"), "resolved\nbase change \n")
          git(cwd, ["add", "f.txt"])
        })
        const result = await runReal(repo, baseSha, targetSha, agent, runRoot)

        expect(Result.isSuccess(result)).toBe(true)
      })))

  test("resolving every conflict in favour of the target leaves index == HEAD, and commitMerge still commits", () =>
    withRunRoot((runRoot) =>
      withDivergedRepo("base change\n", "target change\n", async (repo, baseSha, targetSha) => {
        const agent = realResolver((cwd) => {
          // Discard base's change entirely: the resolved file is exactly target's original content.
          writeFileSync(join(cwd, "f.txt"), "target change\n")
          git(cwd, ["add", "f.txt"])
        })
        const fixed = await runReal(repo, baseSha, targetSha, agent, runRoot)
        expect(Result.isSuccess(fixed)).toBe(true)
        if (!Result.isSuccess(fixed)) return

        const committed = await runCommit(repo, fixed.success.sessions)
        expect(Result.isSuccess(committed)).toBe(true)
        // `--count` and `--parents` don't compose (probed: `--count` suppresses the parents list).
        expect(git(repo, ["rev-list", "--parents", "-1", "HEAD"]).trim().split(" ")).toHaveLength(3)
      })))
})
