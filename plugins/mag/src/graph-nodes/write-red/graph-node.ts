import { Effect, Schema } from "effect"
import {
  WriteRedCommitFailed,
  WriteRedGitFailed,
  WriteRedHeadMoved,
  WriteRedNoTests,
  WriteRedPathsMissing,
  WriteRedPathsUndeclared,
  WriteRedWorkdirDirty
} from "mag/graph-nodes/write-red/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { commitAgentLeftovers, gitRead, gitReadRaw } from "mag/runtime/git"
import { dirtyPaths } from "mag/runtime/porcelain"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { renderPlan, TestPlan } from "mag/runtime/test-plan"

/** The session's partition of what it wrote; the commit is the territory it is checked against. */
const VERDICT = verdictSchema(Schema.Struct({ testPaths: Schema.Array(Schema.String), stubPaths: Schema.Array(Schema.String) }))

/**
 * Red for the right reason: a stub exists so the test compiles and reaches its assertion, never
 * so it passes. No suite command travels here; `assert-red` proves the colour afterwards.
 */
const promptFor = (plan: TestPlan, addendum: string | undefined): string =>
  [
    "Write the tests in this plan, then stop. Each test must fail on its own assertion against the current code: create only the source stubs the tests need to compile, and leave every assertion red. Leave your changes uncommitted; this node commits.",
    "Reply with `testPaths` (every test file you wrote) and `stubPaths` (every source file you created or changed), repo-relative.",
    renderPlan(plan),
    ...(addendum === undefined || addendum === "" ? [] : ["", addendum])
  ].join("\n")

const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `test(${ticket}): red tests`,
    "",
    "The write-red node wrote the planned tests, each red on its own assertion, and committed them.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * Writes the planned tests and commits them, then checks the session's declaration against the
 * commit: every changed path is a declared test or stub, every declared path changed. The
 * declaration matters because `testPaths` is what the implementation pass is forbidden to touch,
 * so a test file the session forgot to declare would be a test the gate never guards.
 *
 * `headSha` is the tree this pass writes on top of, checked before any dispatch; the journal keys a
 * row on its input, and a plan-only input would replay one tree's tests onto another.
 */
export const writeRed = make({
  name: "write-red",
  description: "Write the planned tests so each is red on its own assertion, commit them, and declare which paths are tests.",
  input: Schema.Struct({
    plan: TestPlan,
    headSha: Schema.String,
    /** Extra instructions spliced verbatim, `build`'s convention: a loop names what the previous attempt got wrong. */
    addendum: Schema.optional(Schema.String),
    /** A named agent from the target repo's `.claude/agents/`, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    testPaths: Schema.Array(Schema.String),
    stubPaths: Schema.Array(Schema.String),
    /** The commit the red tests landed on, the tree `assert-red` is then pointed at. */
    redSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number),
    sessionRef: Schema.String
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      const fail = (fields: { argv: string; exitCode: number; stderr: string }) => new WriteRedGitFailed(fields)

      const observed = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, fail)
      if (observed !== input.headSha) return yield* Effect.fail(new WriteRedHeadMoved({ expected: input.headSha, observed }))
      const status = yield* gitReadRaw(["git", "status", "--porcelain"], cwd, fail)
      const dirty = dirtyPaths(status)
      if (dirty.length > 0) return yield* Effect.fail(new WriteRedWorkdirDirty({ paths: dirty }))

      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: promptFor(input.plan, input.addendum),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })
      if (reply.verdict.testPaths.length === 0) return yield* Effect.fail(new WriteRedNoTests({ sessions: reply.sessions }))

      yield* commitAgentLeftovers(
        cwd,
        commitMessageFor(runInfo.ticket, reply.sessions),
        reply.sessions,
        fail,
        (fields) => new WriteRedCommitFailed(fields)
      )

      const changedText = yield* gitRead(["git", "diff", "--name-only", input.headSha, "HEAD"], cwd, fail)
      const changed = new Set(changedText.split("\n").filter((line) => line !== ""))
      const declared = new Set([...reply.verdict.testPaths, ...reply.verdict.stubPaths])
      const undeclared = [...changed].filter((path) => !declared.has(path))
      if (undeclared.length > 0) {
        return yield* Effect.fail(new WriteRedPathsUndeclared({ paths: undeclared, sessions: reply.sessions }))
      }
      const missing = [...declared].filter((path) => !changed.has(path))
      if (missing.length > 0) return yield* Effect.fail(new WriteRedPathsMissing({ paths: missing, sessions: reply.sessions }))

      const redSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, fail)
      return {
        testPaths: reply.verdict.testPaths,
        stubPaths: reply.verdict.stubPaths,
        redSha,
        sessions: reply.sessions,
        costUsd: reply.costUsd,
        sessionRef: reply.sessions[0]!
      }
    })
})
