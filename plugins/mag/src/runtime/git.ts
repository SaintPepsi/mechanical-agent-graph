import { Effect, Semaphore } from "effect"
import { dirtyPaths } from "mag/runtime/porcelain"
import { Shell } from "mag/runtime/shell"

/**
 * One permit for every write to the index this process makes. A run is one process and one
 * worktree, and `design-graph` runs `envision-visions` and `discover` side by side, each
 * committing its own artifact into that worktree: git serialises writers with `index.lock`, and the
 * loser of the race dies `fatal: Unable to create '.git/.../index.lock': File exists`. Queueing
 * here, in the one seam every artifact commit passes through, is the fix that holds for every node
 * at once; a retry in each caller would be the per-node edit the definition rule forbids. Reads
 * (`gitRead`) take no permit: git never locks the index for them.
 */
const INDEX_WRITES = Effect.runSync(Semaphore.make(1))

/**
 * The shared git-argv-runner. `gitRead` (trimmed) and `gitReadRaw` (untrimmed) are the two shapes
 * every git-calling node needs, so nodes read git through these exports rather than each keeping
 * its own local copy of the same shell-call-plus-exit-code-branch.
 *
 * All three exports are generic over the caller's own tagged error, never minting one of their own: a
 * closed error union stays closed (repo `CLAUDE.md`), and `simplify`'s `errors.ts` owns
 * `SimplifyGitFailed`/`SimplifyCommitFailed` the same way `build/errors.ts` owns `BuildGitFailed`/
 * `BuildCommitFailed`. `Shell` is read from the `R` channel inside each helper's own Effect, never
 * threaded through as a parameter.
 */

/** The fields a failed git call's `E` constructor receives — the shape every inline copy already used. */
export interface GitFailureFields {
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}

/**
 * Runs one git argv, trims stdout on exit 0, fails the caller's own error on a non-zero exit.
 * Built on {@link gitReadRaw} rather than its own copy of the shell call and exit-code branch: the
 * two differ only in whether `stdout` is trimmed, so `gitRead` is `gitReadRaw` plus a `map`.
 * Callers that need the untrimmed line-oriented or NUL-separated form — `git status --porcelain`,
 * or a `-z` read — use {@link gitReadRaw} directly instead.
 */
export const gitRead = <E>(
  argv: readonly [string, ...string[]],
  cwd: string | undefined,
  onFailure: (fields: GitFailureFields) => E
) => gitReadRaw(argv, cwd, onFailure).pipe(Effect.map((stdout) => stdout.trim()))

/**
 * Runs one git argv, exit-code-gated the same way as {@link gitRead}, but returns `stdout` raw.
 * Every caller reading a line-oriented or NUL-separated form needs this instead of `gitRead`'s
 * whole-string trim: `git status --porcelain` (a whole-string trim eats a real character off the
 * first path whenever that line's status code opens with a space, the common case for an
 * unstaged tracked modification), and `-z` output, whose entries `String.trim` cannot corrupt by
 * removing NUL bytes but which lose nothing by staying untouched either.
 */
export const gitReadRaw = <E>(
  argv: readonly [string, ...string[]],
  cwd: string | undefined,
  onFailure: (fields: GitFailureFields) => E
) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const result = yield* shell.run(argv, { cwd })
    if (result.exitCode !== 0) {
      return yield* Effect.fail(onFailure({ argv: argv.join(" "), exitCode: result.exitCode, stderr: result.stderr.trim() }))
    }
    return result.stdout
  })

/** The fields a failed `git add`/`git commit`'s `E` constructor receives — `BuildCommitFailed`'s own shape, generalised. */
export interface CommitFailureFields {
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}

/**
 * Stages and commits whatever a session left in the tree; a no-op on a clean tree or an empty
 * index. `git add -A` is never trusted to have staged anything just because the probe found the
 * tree dirty — a submodule with untracked content reports modified in `status --porcelain` but
 * leaves nothing at the top level `add -A` can stage, so the index is checked directly (`git diff
 * --cached --quiet`) before a commit is attempted.
 *
 * Two error constructors, not one: a failed `git status`/`git add`/`git diff --cached` read and a
 * failed `git commit` both carry different field shapes in every caller's own tagged error today
 * (`BuildGitFailed`'s three fields vs. `BuildCommitFailed`'s five, `sessions` included) — minting one
 * shared error type here would either drop fields a caller needs or force every caller's error to
 * carry fields it doesn't.
 */
export const commitAgentLeftovers = <EGit, ECommit>(
  cwd: string | undefined,
  message: string,
  sessions: readonly string[],
  onGitFailure: (fields: GitFailureFields) => EGit,
  onCommitFailure: (fields: CommitFailureFields) => ECommit
) =>
  INDEX_WRITES.withPermit(Effect.gen(function* () {
    const shell = yield* Shell
    const status = yield* gitReadRaw(["git", "status", "--porcelain"], cwd, onGitFailure)
    if (dirtyPaths(status).length === 0) return

    const addArgv = ["git", "add", "-A"] as const
    const add = yield* shell.run(addArgv, { cwd })
    if (add.exitCode !== 0) {
      return yield* Effect.fail(
        onCommitFailure({
          argv: addArgv.join(" "),
          exitCode: add.exitCode,
          stderr: add.stderr.trim(),
          stdout: add.stdout.trim(),
          sessions
        })
      )
    }

    // `--quiet` makes the exit code the answer: 0 means the staged tree matches HEAD (a dirty probe
    // that staged nothing, the submodule case above), anything else means it doesn't.
    const staged = yield* shell.run(["git", "diff", "--cached", "--quiet"], { cwd })
    if (staged.exitCode === 0) return

    const commit = yield* shell.run(["git", "commit", "-m", message], { cwd })
    if (commit.exitCode !== 0) {
      return yield* Effect.fail(
        onCommitFailure({
          argv: "git commit -m <message>",
          exitCode: commit.exitCode,
          stderr: commit.stderr.trim(),
          stdout: commit.stdout.trim(),
          sessions
        })
      )
    }
  }))

/**
 * Stages and commits exactly one path — the pathspec-limited sibling of {@link commitAgentLeftovers}.
 * Called directly by `envision-mermaid`/`envision-rail-sketch` to commit their own deliverable
 * unconditionally, and by `records.ts`'s `record` on behalf of every other record-writing node
 * (`discover`, `brainstorm`, `design`, `envision-notation`) when this repository's own policy is
 * `records: "committed"`. Where `commitAgentLeftovers`
 * trusts a session to have left only its own leftovers in a dirty tree, this node never trusts that:
 * `git add` is scoped to `path` alone, so a session that strays and writes its sibling artifact
 * leaves an uncommitted stray, not a committed one, a mechanical guard rather than one resting on
 * prompt wording. The final `commit` carries the same pathspec, a second, redundant guard against
 * anything the index might otherwise hold staged.
 *
 * The same two constructors as above, split at a different line: a failed `add` is a state change
 * nothing has been spent on yet and fails the git-failure constructor, so only a failed `commit`, the
 * one step that fails with the session's work already spent, carries `sessions`.
 */
export const commitPath = <EGit, ECommit>(
  cwd: string | undefined,
  path: string,
  message: string,
  sessions: readonly string[],
  onGitFailure: (fields: GitFailureFields) => EGit,
  onCommitFailure: (fields: CommitFailureFields) => ECommit
) =>
  INDEX_WRITES.withPermit(Effect.gen(function* () {
    yield* gitReadRaw(["git", "add", "--", path], cwd, onGitFailure)

    const shell = yield* Shell
    // `--quiet` makes the exit code the answer, `commitAgentLeftovers`'s own idiom: 0 means the
    // staged tree matches HEAD for this path, so there is nothing new to commit.
    const staged = yield* shell.run(["git", "diff", "--cached", "--quiet", "--", path], { cwd })
    if (staged.exitCode === 0) return

    const commit = yield* shell.run(["git", "commit", "-m", message, "--", path], { cwd })
    if (commit.exitCode !== 0) {
      return yield* Effect.fail(
        onCommitFailure({
          argv: `git commit -m <message> -- ${path}`,
          exitCode: commit.exitCode,
          stderr: commit.stderr.trim(),
          stdout: commit.stdout.trim(),
          sessions
        })
      )
    }
  }))
