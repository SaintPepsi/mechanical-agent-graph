import { Effect, Schema } from "effect"
import {
  SimplifyCommitFailed,
  SimplifyGitFailed,
  SimplifyHeadMoved,
  SimplifyRunRootMissing,
  SimplifyWorkdirDirty
} from "mag/graph-nodes/simplify/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { commitAgentLeftovers, gitRead, gitReadRaw } from "mag/runtime/git"
import { dirtyPaths } from "mag/runtime/porcelain"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { compileSubtraction, SIMPLIFY_PARAMS } from "mag/skills/subtraction"

/** What the session must return: one line about what it did. Nothing that restates the diff — `simplified` is computed from `git`, never from this. */
const VERDICT = verdictSchema(Schema.Struct({ note: Schema.String }))

/**
 * The range, then the standard. Ticket-blind by design: no title, no body, a subtraction pass judges
 * the diff on its own terms, and handing it the ticket invites implementation rather than reduction.
 * No suite command travels here: the loop that dispatches this node verifies every head it produces
 * and repairs a red one by resuming the session, so no sentence is asking this session to verify
 * itself. The opening line is deliberately distinctive: it doubles as the node's own description, so
 * a test harness can route a dispatch by prompt substring the way `build-under-review`'s existing
 * stubs already route build vs review-diff.
 */
const promptFor = (range: string): string =>
  [
    `Reduce this diff to the same behaviour in less code: \`git diff ${range}\`. Edit the tree and`,
    "leave your changes uncommitted, this node commits the result, not you.",
    "",
    compileSubtraction(SIMPLIFY_PARAMS)
  ].join("\n")

/** Standing in the tree it was told to gate, or not: checked before any other read and before any dispatch (`review-diff`'s `ReviewHeadMoved` precedent). */
const guardHead = (cwd: string | undefined, expected: string) =>
  Effect.gen(function* () {
    const observed = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new SimplifyGitFailed(fields))
    if (observed !== expected) return yield* Effect.fail(new SimplifyHeadMoved({ expected, observed }))
  })

/**
 * `git diff --name-only <range>`: an empty answer is the whole reason to skip a dispatch. No `-z`,
 * no `--no-renames` — a simpler question than `review-diff`'s governing-principles read: just "is
 * there anything". Called from the loop this can never see an empty range, because `build` guarantees
 * `commits > 0`; it exists for the standalone CLI path.
 */
const changedPaths = (cwd: string | undefined, range: string) =>
  Effect.gen(function* () {
    const stdout = yield* gitRead(["git", "diff", "--name-only", range], cwd, (fields) => new SimplifyGitFailed(fields))
    return stdout.split("\n").filter((line) => line.trim() !== "")
  })

/**
 * Pre-existing dirt is not this session's to sweep into its own commit — `push-branch`'s
 * `guardCleanTree` precedent, same gate, own error tag: reads the porcelain status through
 * {@link gitReadRaw} (`runtime/git.ts`, the untrimmed line format {@link dirtyPaths} needs) rather
 * than a fourth reimplementation of the same three-line shell read.
 */
const guardCleanTree = (cwd: string | undefined) =>
  Effect.gen(function* () {
    const status = yield* gitReadRaw(["git", "status", "--porcelain"], cwd, (fields) => new SimplifyGitFailed(fields))
    const paths = dirtyPaths(status)
    if (paths.length > 0) return yield* Effect.fail(new SimplifyWorkdirDirty({ paths }))
  })

/**
 * The commit subject and body, node-authored, one `Claude-Session` trailer per session —
 * `build`'s `commitMessageFor` precedent: the agent produces the change, the node makes the commit.
 * Subject keeps the `refactor(<TICKET>):` prefix; `<scope>` is dropped because it would have to come
 * from the reply, the same reasoning that keeps a self-reported figure out of a commit message.
 */
const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `refactor(${ticket}): simplify`,
    "",
    "The simplify node reduced the build diff to the same behaviour in less code and",
    "committed the result.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

export const simplify = make({
  name: "simplify",
  description: "Reduce the build diff to the same behaviour in less code and commit the result.",
  input: Schema.Struct({
    ticket: Schema.String,
    base: Schema.String,
    headSha: Schema.String,
    /** A named agent from the target repo's `.claude/agents/`, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    /** Computed from `git`, never from the reply. */
    simplified: Schema.Boolean,
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number),
    /**
     * The session a caller can resume to repair this pass's own head, same convention as `build`'s
     * field. Absent on the no-dispatch path (`changed.length === 0` below): no session ever ran, so
     * there is nothing to resume.
     */
    sessionRef: Schema.optional(Schema.String)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new SimplifyRunRootMissing())
      const cwd = workdir(runInfo)

      yield* guardHead(cwd, input.headSha)

      const range = `${input.base}...HEAD`
      const changed = yield* changedPaths(cwd, range)
      if (changed.length === 0) return { simplified: false, headSha: input.headSha, sessions: [], costUsd: 0 }

      yield* guardCleanTree(cwd)

      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: promptFor(range),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      yield* commitAgentLeftovers(
        cwd,
        commitMessageFor(input.ticket, reply.sessions),
        reply.sessions,
        (fields) => new SimplifyGitFailed(fields),
        (fields) => new SimplifyCommitFailed(fields)
      )

      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new SimplifyGitFailed(fields))

      return {
        simplified: headSha !== input.headSha,
        headSha,
        sessions: reply.sessions,
        costUsd: reply.costUsd,
        sessionRef: reply.sessions[0]!
      }
    })
})
