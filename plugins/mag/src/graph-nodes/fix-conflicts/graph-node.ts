import { Effect, FileSystem, Schema } from "effect"
import {
  FixCommitFailed,
  FixConflictMarkersLeft,
  FixConflictsUnresolved,
  FixGitFailed,
  FixMergeStartFailed,
  FixMergeWithoutConflict,
  FixRunRootMissing,
  FixSummaryEmpty,
  FixSummaryWriteFailed,
  FixWorkdirDirty
} from "mag/graph-nodes/fix-conflicts/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { dirtyPaths } from "mag/runtime/porcelain"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/** What the resolver must return; nothing about the resolution is trusted from it (the tree is measured). */
const SUMMARY = verdictSchema(Schema.Struct({ summary: Schema.String }))

/** NUL-separated `git diff --name-only --diff-filter=U -z` output, the same parse shape both reads of it share. */
const unmergedPaths = (stdout: string): readonly string[] => stdout.split("\0").filter((path) => path !== "")

/**
 * The resolver produces the change, this node stages and proves it — never commits it. Names the
 * paths it is being handed and forbids exactly the operations that would leave the tree without a
 * resolution to prove: no commit, no abort, no reset.
 */
const promptFor = (input: { readonly base: string; readonly target: string; readonly paths: readonly string[] }): string =>
  [
    `Branch \`${input.target}\` has a merge conflict against \`${input.base}\` already open in this`,
    "working tree (`git merge --no-commit --no-ff`), in the following paths:",
    ...input.paths.map((path) => `- ${path}`),
    "",
    "Resolve every conflict marker in these files so the merge is complete and correct, preserving",
    "the intent of both sides rather than mechanically favouring one. Once a file's conflict is",
    "resolved, `git add` it. Do not run `git commit`, `git merge --abort`, or `git reset` — this",
    "node commits the result once it has checked the tree itself. Reply with a short summary of how",
    "each conflict was resolved."
  ].join("\n")

/** Names the merge in its subject, this node's own commit step in its body, one `Claude-Session:` trailer per session. */
const commitMessageFor = (base: string, target: string, sessions: readonly string[]): string =>
  [
    `Merge ${base} into ${target}`,
    "",
    "Conflicts resolved by the fix-conflicts node's resolver session.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/** A git call whose non-zero exit means this domain cannot answer its own question — `build`'s own `git` helper. */
const git = (cwd: string | undefined, argv: readonly [string, ...string[]]) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const result = yield* shell.run(argv, { cwd })
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new FixGitFailed({ argv: argv.join(" "), exitCode: result.exitCode, stderr: result.stderr.trim() })
      )
    }
    return result
  })

/** The mechanical commit step: finishes the merge `fixConflicts.run` left open, once `resolve-conflicts` has verified the staged tree. Not wrapped in `make()` — it is that node's own finishing write, just run later. */
export const commitMerge = (
  cwd: string | undefined,
  base: string,
  target: string,
  sessions: readonly string[]
) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const message = commitMessageFor(base, target, sessions)
    const commit = yield* shell.run(["git", "commit", "-m", message], { cwd })
    if (commit.exitCode !== 0) {
      return yield* Effect.fail(
        new FixCommitFailed({
          argv: "git commit -m <message>",
          exitCode: commit.exitCode,
          stderr: commit.stderr.trim(),
          sessions
        })
      )
    }

    const head = yield* git(cwd, ["git", "rev-parse", "HEAD"])
    return { headSha: head.stdout.trim() }
  })

/** Starts the real merge, dispatches the resolver at the live unmerged set, proves and stages the result. Never commits, never aborts or resets on failure: a half-resolved tree stays for a human to read. */
export const fixConflicts = make({
  name: "fix-conflicts",
  description: "Start the real merge, dispatch the resolver at the live unmerged set, prove and stage the result.",
  input: Schema.Struct({
    base: Schema.String,
    target: Schema.String,
    /** Pins the tip each side was actually at, for `journaled` replay identity — neither is read by the merge. */
    baseSha: Schema.String,
    targetSha: Schema.String,
    /** A named agent from the target repo's `.claude/agents/`, passed through verbatim. */
    agent: Schema.optional(Schema.String),
    /** `--model`, overriding the agent's pinned frontmatter. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    paths: Schema.Array(Schema.String),
    /** The staged, unresolved-marker-free tree's own object id — `git write-tree`, real and mechanical. */
    treeSha: Schema.String,
    summaryPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo

      // Guard: an empty runRoot means no worktree is wired up either — unguarded, `workdir` would
      // fall back to the maintainer's primary checkout and merge for real there.
      if (runInfo.runRoot === "") return yield* Effect.fail(new FixRunRootMissing())
      const cwd = workdir(runInfo)

      // Guard: refuse before any spend when the tree is already dirty.
      const status = yield* git(cwd, ["git", "status", "--porcelain"])
      const dirty = dirtyPaths(status.stdout)
      if (dirty.length > 0) return yield* Effect.fail(new FixWorkdirDirty({ paths: dirty }))

      // Start the merge.
      const mergeArgv = ["git", "merge", "--no-commit", "--no-ff", input.base] as const
      const merge = yield* shell.run(mergeArgv, { cwd })
      if (merge.exitCode === 0) {
        return yield* Effect.fail(new FixMergeWithoutConflict({ base: input.base, target: input.target }))
      }
      if (merge.exitCode !== 1) {
        return yield* Effect.fail(
          new FixMergeStartFailed({ base: input.base, exitCode: merge.exitCode, stderr: merge.stderr.trim() })
        )
      }

      // Re-measure: the tree the agent will actually edit, not the odb detect-conflicts probed.
      const unmerged = yield* git(cwd, ["git", "diff", "--name-only", "--diff-filter=U", "-z"])
      const paths = unmergedPaths(unmerged.stdout)

      const reply = yield* agent.prompt({
        prompt: promptFor({ base: input.base, target: input.target, paths }),
        jsonSchema: SUMMARY,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      if (reply.verdict.summary.trim() === "") {
        return yield* Effect.fail(new FixSummaryEmpty({ sessions: reply.sessions }))
      }

      const fs = yield* FileSystem.FileSystem
      const summaryPath = yield* writeArtifact(fs, runInfo.runRoot, "fix-conflicts", reply.verdict.summary).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new FixSummaryWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions })
          )
        )
      )

      // Prove it mechanically, neither check asks the model anything. Unmerged first, before
      // `git add -A` touches anything: `git add` collapses a path's unmerged stages into one
      // stage-0 entry regardless of content, so adding first would hide an untouched path.
      const stillUnmerged = yield* git(cwd, ["git", "diff", "--name-only", "--diff-filter=U", "-z"])
      const remaining = unmergedPaths(stillUnmerged.stdout)
      if (remaining.length > 0) {
        return yield* Effect.fail(new FixConflictsUnresolved({ paths: remaining }))
      }

      // Stage everything now: the resolver's own incremental `git add` calls are not what reaches
      // the check and the eventual commit below, this is. The check right after this is the last
      // read before anything is committed, on exactly the tree the commit will carry.
      const add = yield* shell.run(["git", "add", "-A"], { cwd })
      if (add.exitCode !== 0) {
        return yield* Effect.fail(
          new FixCommitFailed({
            argv: "git add -A",
            exitCode: add.exitCode,
            stderr: add.stderr.trim(),
            sessions: reply.sessions
          })
        )
      }

      // Git's own leftover-conflict-marker detector, on the tree that is actually staged. Exit 0
      // (clean) and 2 (findings) are its only valid answers (probed, git 2.53.0); anything else is
      // `FixGitFailed`, bypassing the `git` helper only because 2 is not itself a failure here.
      // Scoped to marker lines alone: `--check` also reports whitespace violations unrelated to a
      // resolved conflict, which a codebase-agnostic pipeline cannot let decide whether this works.
      const check = yield* shell.run(["git", "diff", "--cached", "--check"], { cwd })
      if (check.exitCode !== 0 && check.exitCode !== 2) {
        return yield* Effect.fail(
          new FixGitFailed({
            argv: "git diff --cached --check",
            exitCode: check.exitCode,
            stderr: check.stderr.trim()
          })
        )
      }
      const markerLines = check.stdout.split("\n").filter((line) => line.includes("leftover conflict marker"))
      if (markerLines.length > 0) {
        return yield* Effect.fail(new FixConflictMarkersLeft({ detail: markerLines.join("\n") }))
      }

      // The staged tree's own object id, real and mechanical — `resolve-conflicts` runs `verification`
      // against it, then `commitMerge` against it, even when it equals HEAD (every conflict resolved
      // in favour of the target is still a legitimate merge, not a vanished one).
      const tree = yield* git(cwd, ["git", "write-tree"])

      return { paths, treeSha: tree.stdout.trim(), summaryPath, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
