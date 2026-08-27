import { Effect, FileSystem, Schema } from "effect"
import {
  ImplementCommitFailed,
  ImplementDisputeWriteFailed,
  ImplementGitFailed,
  ImplementHeadMoved,
  ImplementNoCommits,
  ImplementResumeEmpty,
  ImplementRunRootMissing,
  ImplementWorkdirDirty,
  TestDisputed
} from "mag/graph-nodes/implement/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { commitAgentLeftovers, gitRead, gitReadRaw } from "mag/runtime/git"
import { platform } from "mag/runtime/platform"
import { dirtyPaths } from "mag/runtime/porcelain"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { renderPlan, TestPlan } from "mag/runtime/test-plan"

/** `dispute` is `optionalKey`, `build`'s reasoning: `optional` would show the model a nullable field on every ordinary pass. */
const VERDICT = verdictSchema(Schema.Struct({ summary: Schema.String, dispute: Schema.optionalKey(Schema.String) }))

/**
 * A resumed pass drops the plan and the framing, the session already holds them; the addendum is
 * then the whole instruction. No suite command travels here: `assert-red` proves the colour, and
 * `paths-untouched` proves the tests were left alone, both mechanically after the fact.
 */
const promptFor = (input: {
  readonly plan: TestPlan
  readonly testPaths: readonly string[]
  readonly resume?: string | undefined
  readonly addendum?: string | undefined
}): string =>
  [
    ...(input.resume !== undefined ? [] : [
      `Make the tests in ${input.testPaths.join(", ")} pass by editing source files only: the tests are the specification. Leave your changes uncommitted; this node commits.`,
      "Reply with a one-line `summary`. When a test is wrong about the specification, say why in `dispute` instead of editing it.",
      renderPlan(input.plan)
    ]),
    ...(input.addendum === undefined || input.addendum === "" ? [] : ["", input.addendum])
  ].join("\n").trimStart()

const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `${ticket}: work committed by the implement node`,
    "",
    "The implement session finished without committing, so the implement node staged and",
    "committed what it left in the working tree.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * The green half of red-green: one session makes the declared tests pass. Ticket-blind, the plan
 * and the test paths are its whole brief. A dispute in the reply ends the pass as
 * {@link TestDisputed} whether or not it also committed: a test the session argues with is not a
 * test it made pass, and the argument is a human's to settle.
 */
export const implement = make({
  name: "implement",
  description: "Make the red tests pass by editing source only, commit, or dispute a test as wrong about the spec.",
  input: Schema.Struct({
    plan: TestPlan,
    testPaths: Schema.Array(Schema.String),
    headSha: Schema.String,
    /** The session this pass resumes, `build`'s convention: the prompt is then the addendum alone. */
    resume: Schema.optional(Schema.String),
    /** Extra instructions spliced verbatim: which tests are still red, in `red-green`'s words. */
    addendum: Schema.optional(Schema.String),
    /** A named agent from the target repo's `.claude/agents/`, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    headSha: Schema.String,
    commits: Schema.Int,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number),
    sessionRef: Schema.String
  }),
  run: (input) =>
    Effect.gen(function* () {
      if (input.resume !== undefined && input.addendum === undefined) return yield* Effect.fail(new ImplementResumeEmpty())
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new ImplementRunRootMissing())
      const cwd = workdir(runInfo)
      const fail = (fields: { argv: string; exitCode: number; stderr: string }) => new ImplementGitFailed(fields)

      const observed = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, fail)
      if (observed !== input.headSha) return yield* Effect.fail(new ImplementHeadMoved({ expected: input.headSha, observed }))
      const status = yield* gitReadRaw(["git", "status", "--porcelain"], cwd, fail)
      const dirty = dirtyPaths(status)
      if (dirty.length > 0) return yield* Effect.fail(new ImplementWorkdirDirty({ paths: dirty }))

      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: promptFor(input),
        jsonSchema: VERDICT,
        cwd,
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      yield* commitAgentLeftovers(
        cwd,
        commitMessageFor(runInfo.ticket, reply.sessions),
        reply.sessions,
        fail,
        (fields) => new ImplementCommitFailed(fields)
      )
      const counted = yield* gitRead(["git", "rev-list", "--count", `${input.headSha}..HEAD`], cwd, fail)
      const commits = Number(counted)
      if (!Number.isInteger(commits)) {
        return yield* Effect.fail(fail({ argv: `git rev-list --count ${input.headSha}..HEAD`, exitCode: 0, stderr: counted }))
      }
      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, fail)

      const dispute = reply.verdict.dispute?.trim() ?? ""
      if (dispute !== "") {
        const fs = yield* FileSystem.FileSystem
        const disputePath = yield* writeArtifact(fs, runInfo.runRoot, "test-dispute", dispute).pipe(
          Effect.catch((error) =>
            Effect.fail(new ImplementDisputeWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions }))
          )
        )
        return yield* Effect.fail(new TestDisputed({ disputePath, headSha, commits, sessions: reply.sessions, costUsd: reply.costUsd }))
      }
      if (commits === 0) {
        // `build`'s head gate: zero forward commits with a moved HEAD is a lost tree, not silence.
        if (headSha !== input.headSha) return yield* Effect.fail(new ImplementHeadMoved({ expected: input.headSha, observed: headSha }))
        return yield* Effect.fail(new ImplementNoCommits({ sessions: reply.sessions }))
      }
      return { headSha, commits, sessions: reply.sessions, costUsd: reply.costUsd, sessionRef: reply.sessions[0]! }
    }).pipe(Effect.provide(platform))
})
