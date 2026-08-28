import { Effect, Schema } from "effect"
import {
  TersenessCommitFailed,
  TersenessGitFailed,
  TersenessHeadMoved,
  TersenessRunRootMissing,
  TersenessWorkdirDirty
} from "mag/graph-nodes/prompt-terseness-evaluator/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { gitRead } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { dirtyPaths } from "mag/runtime/porcelain"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"
import { compilePromptTerseness, EVALUATOR_PARAMS } from "mag/skills/prompt-terseness"

/** What the session must return: a count. The commit is the artifact; nothing here duplicates the diff. */
const VERDICT = verdictSchema(Schema.Struct({ rewritten: Schema.Int }))

/** Compiled fresh at dispatch, inside this node's own runtime: never at module load, never materialized as a file. */
const personaFor = (): string => compilePromptTerseness(EVALUATOR_PARAMS)

/** The range, then the persona: the agent reads the diff itself, so this node hands over only the range. */
const promptFor = (range: string): string =>
  `Diff range \`git diff ${range}\`. Rewrite it under the standard below, then commit.\n\n${personaFor()}`

/** Standing in the tree it was told to gate, or not: checked before any other read and before any dispatch. */
const guardHead = (cwd: string | undefined, expected: string) =>
  Effect.gen(function* () {
    const observed = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (info) => new TersenessGitFailed(info))
    if (observed !== expected) return yield* Effect.fail(new TersenessHeadMoved({ expected, observed }))
    return observed
  })

/** `git diff --name-only <range>`: an empty answer is the whole reason to skip a dispatch — the only genuinely mechanical part of this node's job. */
const changedPaths = (cwd: string | undefined, range: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const argv = ["git", "diff", "--name-only", range] as const
    const result = yield* shell.run(argv, { cwd })
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new TersenessGitFailed({ argv: argv.join(" "), exitCode: result.exitCode, stderr: result.stderr.trim() })
      )
    }
    return result.stdout.split("\n").filter((line) => line.trim() !== "")
  })

/** `git status --porcelain`, read raw for {@link dirtyPaths}. */
const gitStatusPorcelain = (cwd: string | undefined) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const argv = ["git", "status", "--porcelain"] as const
    const result = yield* shell.run(argv, { cwd })
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new TersenessGitFailed({ argv: argv.join(" "), exitCode: result.exitCode, stderr: result.stderr.trim() })
      )
    }
    return result.stdout
  })

/** Subject names the run's own ticket, the target repo's tracker id, never a fixed id from this repo. */
const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `${ticket}: work committed by prompt-terseness-evaluator`,
    "",
    "The evaluator session rewrote verbose prompt text and this node committed the result.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/** The session produces the change, the node makes the commit: a no-op on a clean tree or an empty index. */
const commitLeftovers = (cwd: string | undefined, message: string, sessions: readonly string[]) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const status = yield* gitStatusPorcelain(cwd)
    if (dirtyPaths(status).length === 0) return

    const addArgv = ["git", "add", "-A"] as const
    const add = yield* shell.run(addArgv, { cwd })
    if (add.exitCode !== 0) {
      return yield* Effect.fail(
        new TersenessCommitFailed({
          argv: addArgv.join(" "),
          exitCode: add.exitCode,
          stderr: add.stderr.trim(),
          stdout: add.stdout.trim(),
          sessions
        })
      )
    }

    const staged = yield* shell.run(["git", "diff", "--cached", "--quiet"], { cwd })
    if (staged.exitCode === 0) return

    const commit = yield* shell.run(["git", "commit", "-m", message], { cwd })
    if (commit.exitCode !== 0) {
      return yield* Effect.fail(
        new TersenessCommitFailed({
          argv: "git commit -m <message>",
          exitCode: commit.exitCode,
          stderr: commit.stderr.trim(),
          stdout: commit.stdout.trim(),
          sessions
        })
      )
    }
  })

/** Standalone via the derived CLI, or wired into `develop-graph` after `build-under-review`. */
export const promptTersenessEvaluator = make({
  name: "prompt-terseness-evaluator",
  description: "Rewrite verbose prompt text on a branch as terse one-liners and commit the result.",
  input: Schema.Struct({
    /** The run's own ticket, named in the commit subject: the target repo's tracker id, never this repo's. */
    ticket: Schema.String,
    base: Schema.String,
    /** The head this pass is gating: required, so a resumed run replays against the tree it actually repaired. */
    headSha: Schema.String,
    /** A named agent from the target repo's `.claude/agents/` to run the session as. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    rewritten: Schema.Int,
    /** The commit this pass left `HEAD` on — unchanged from `input.headSha` when nothing needed rewriting. */
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new TersenessRunRootMissing())
      const cwd = workdir(runInfo)

      yield* guardHead(cwd, input.headSha)

      const range = `${input.base}...HEAD`
      const changed = yield* changedPaths(cwd, range)
      // costUsd: 0, not null — null would mean an unpriced session ran, and none did here.
      if (changed.length === 0) return { rewritten: 0, headSha: input.headSha, sessions: [], costUsd: 0 }

      // Pre-dispatch dirty guard: pre-existing dirt is not this session's to sweep into its own commit.
      const preStatus = yield* gitStatusPorcelain(cwd)
      const preDirty = dirtyPaths(preStatus)
      if (preDirty.length > 0) return yield* Effect.fail(new TersenessWorkdirDirty({ paths: preDirty }))

      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: promptFor(range),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      yield* commitLeftovers(cwd, commitMessageFor(input.ticket, reply.sessions), reply.sessions)

      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (info) => new TersenessGitFailed(info))
      return { rewritten: reply.verdict.rewritten, headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    })
})
