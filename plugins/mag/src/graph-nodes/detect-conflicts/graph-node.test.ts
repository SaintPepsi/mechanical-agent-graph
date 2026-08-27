import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { ConflictProbeFailed, ConflictRefMissing } from "mag/graph-nodes/detect-conflicts/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/detect-conflicts/examples"
import { detectConflicts } from "mag/graph-nodes/detect-conflicts/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { liveShell, type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"

/** Like resolve-base's `scriptedShell`: one canned reply per call, in order, recording argv and cwd. */
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

const exit = (exitCode: number, stdout = "", stderr = ""): ShellResult => ({ exitCode, stdout, stderr })

const RUN = testRunInfo()

const INPUT = { base: "main", target: "feat/gh-184-fix" }

/** A single-file conflict's real stdout shape (probed, git 2.53.0, `conflict-paths.test.ts`'s own fixture). */
const conflictStdout = [
  "19fa8082a974fee83ab37a693a913f24f5bd6113",
  "f.txt",
  "",
  "1",
  "f.txt",
  "Auto-merging",
  "Auto-merging f.txt\n",
  "1",
  "f.txt",
  "CONFLICT (contents)",
  "CONFLICT (content): Merge conflict in f.txt\n"
].join("\0") + "\0"

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService) =>
  Effect.runSync(
    Effect.result(effect.pipe(Effect.provide(shellLayer(service)), Effect.provideService(RunInfo, RUN)))
  )

describe("detect-conflicts", () => {
  test("the fixtures decode against detect-conflicts's own schemas", () => {
    if (!isSchemaHandle(detectConflicts.input)) throw new Error("detectConflicts.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(detectConflicts.input)(example)
    if (!isSchemaHandle(detectConflicts.success)) throw new Error("detectConflicts.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(detectConflicts.success)(example)
  })

  test("a genuine conflict succeeds with the parsed paths and both shas, no session dispatch", () => {
    const { calls, service } = scriptedShell([
      exit(0, "bbb222\n"), // rev-parse --verify target
      exit(0, "aaa111\n"), // rev-parse --verify base
      exit(1, conflictStdout) // merge-tree, conflicting
    ])
    const result = runWith(detectConflicts.run(INPUT), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({
      base: "main",
      target: "feat/gh-184-fix",
      baseSha: "aaa111",
      targetSha: "bbb222",
      conflicts: ["f.txt"]
    })
    // No ClaudeAgent dependency exists on this node at all — the call log is exhaustively git.
    expect(calls.map((call) => call.argv)).toStrictEqual([
      ["git", "rev-parse", "--verify", "-q", "refs/heads/feat/gh-184-fix"],
      ["git", "rev-parse", "--verify", "-q", "refs/heads/main"],
      ["git", "merge-tree", "--write-tree", "--name-only", "-z", "feat/gh-184-fix", "main"]
    ])
  })

  test("a clean probe (exit 0) succeeds with an empty conflict list, no further calls", () => {
    const { calls, service } = scriptedShell([
      exit(0, "bbb222\n"),
      exit(0, "aaa111\n"),
      exit(0, "ccc333\n") // merge-tree, clean: write-tree oid only
    ])
    const result = runWith(detectConflicts.run(INPUT), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.conflicts).toStrictEqual([])
    expect(calls).toHaveLength(3)
  })

  test("the target ref not resolving fails ConflictRefMissing before merge-tree ever runs", () => {
    const { calls, service } = scriptedShell([exit(1)])
    const result = runWith(detectConflicts.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new ConflictRefMissing({ ref: "feat/gh-184-fix" }))
    expect(calls).toHaveLength(1)
  })

  test("the base ref not resolving fails ConflictRefMissing, target already verified", () => {
    const { calls, service } = scriptedShell([exit(0, "bbb222\n"), exit(1)])
    const result = runWith(detectConflicts.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new ConflictRefMissing({ ref: "main" }))
    expect(calls).toHaveLength(2)
  })

  test("unrelated histories (exit 128) fails ConflictProbeFailed, never read as a conflict", () => {
    const stderr = "fatal: refusing to merge unrelated histories\n"
    const { service } = scriptedShell([exit(0, "bbb222\n"), exit(0, "aaa111\n"), exit(128, "", stderr)])
    const result = runWith(detectConflicts.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ConflictProbeFailed)
    const failure = result.failure as ConflictProbeFailed
    expect(failure.exitCode).toBe(128)
    expect(failure.stderr).toBe("fatal: refusing to merge unrelated histories")
  })

  test("an exit 1 naming no path fails ConflictProbeFailed rather than a false-empty conflict list", () => {
    const { service } = scriptedShell([exit(0, "bbb222\n"), exit(0, "aaa111\n"), exit(1, "")])
    const result = runWith(detectConflicts.run(INPUT), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(ConflictProbeFailed)
  })

  test("every probe runs in RunInfo.repoRoot, never a worktree", () => {
    const { calls, service } = scriptedShell([exit(0, "bbb222\n"), exit(0, "aaa111\n"), exit(0, "ccc333\n")])
    runWith(detectConflicts.run(INPUT), service)
    expect(calls.map((call) => call.cwd)).toStrictEqual(["/repo", "/repo", "/repo"])
  })
})

/**
 * Real-git regression coverage: a scripted shell proves this node formats the right argv, not that
 * `merge-tree`'s exit codes and `-z` output mean what `conflict-paths.ts` assumes they mean. These
 * tests run the node against real `liveShell`, in a real temp repo, with no worktree at all — the
 * odb-only probe this node's own docstring claims to be.
 */
describe("detect-conflicts, real git (pins the odb-only probe against a real repo)", () => {
  const git = (cwd: string, args: readonly string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" })

  /** A real repo with `base` and `target` diverged on the same line of `f.txt`, no merge ever started. */
  const divergedRepo = (baseContent: string, targetContent: string): string => {
    const repo = mkdtempSync(join(tmpdir(), "detect-conflicts-real-git-"))
    git(repo, ["init", "-q", "-b", "main"])
    git(repo, ["config", "user.email", "a@b.c"])
    git(repo, ["config", "user.name", "a"])
    // Ten lines, not one: git's recursive merge needs context around a hunk to tell an isolated
    // change from a conflicting one (probed) — a single-line file conflicts on any edit to either side.
    writeFileSync(join(repo, "f.txt"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n")
    git(repo, ["add", "f.txt"])
    git(repo, ["commit", "-qm", "base"])
    git(repo, ["checkout", "-q", "-b", "target"])
    writeFileSync(join(repo, "f.txt"), targetContent)
    git(repo, ["commit", "-qam", "target"])
    git(repo, ["checkout", "-q", "main"])
    writeFileSync(join(repo, "f.txt"), baseContent)
    git(repo, ["commit", "-qam", "base2"])
    return repo
  }

  /** `liveShell` is `Bun.spawn`-backed, an asynchronous Effect — `fix-conflicts`'s own real-git precedent. */
  const runReal = (repo: string, input: { readonly base: string; readonly target: string }) =>
    Effect.runPromise(
      Effect.result(
        detectConflicts.run(input).pipe(
          Effect.provide(shellLayer(liveShell)),
          Effect.provideService(RunInfo, testRunInfo({ repoRoot: repo }))
        )
      )
    )

  test("a genuine conflict succeeds with the real conflicting path, no worktree ever created", async () => {
    // Both sides rewrite the same first line differently (probed, git 2.53.0): a genuine conflict.
    const repo = divergedRepo("A\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "Z\nb\nc\nd\ne\nf\ng\nh\ni\nj\n")
    try {
      const result = await runReal(repo, { base: "main", target: "target" })
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.conflicts).toStrictEqual(["f.txt"])
      expect(result.success.baseSha).toBe(git(repo, ["rev-parse", "main"]).trim())
      expect(result.success.targetSha).toBe(git(repo, ["rev-parse", "target"]).trim())
      // No worktree, no working-tree change: still on `main`, still clean.
      expect(git(repo, ["status", "--porcelain"])).toBe("")
      expect(git(repo, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe("main")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("a genuinely clean pair succeeds with an empty conflict list", async () => {
    // Base rewrites the first line; target only appends a trailing line — different hunks, no overlap
    // (probed, git 2.53.0): recursive merge takes both changes cleanly.
    const repo = divergedRepo("A\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n")
    try {
      const result = await runReal(repo, { base: "main", target: "target" })
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.conflicts).toStrictEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("a target ref that does not exist fails ConflictRefMissing, never reaches merge-tree", async () => {
    const repo = divergedRepo("base change\n", "target change\n")
    try {
      const result = await runReal(repo, { base: "main", target: "no-such-branch" })
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toStrictEqual(new ConflictRefMissing({ ref: "no-such-branch" }))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
