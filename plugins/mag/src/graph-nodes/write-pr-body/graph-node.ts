import { Effect, FileSystem, Schema } from "effect"
import {
  PrBodyDescriptionWriteFailed,
  PrBodyDiffWriteFailed,
  PrBodyGitFailed,
  PrBodyRunRootMissing
} from "mag/graph-nodes/write-pr-body/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { gitRead } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"
import { TICKET_TOKEN } from "mag/skills/design/tokens"
import { DESIGN_DESTINATION } from "mag/skills/design/write-and-confirm"
import { compileChangelog, PR_BODY_PARAMS } from "mag/skills/changelog"

/**
 * Single home for the design destination (`skills/design/write-and-confirm.ts`'s `DESIGN_DESTINATION`,
 * the same constant `design/graph-node.ts`'s own path composer reads) sliced down to its
 * ticket-agnostic directory, then turned into a `git diff` pathspec exclusion. Under `records:
 * "committed"` the record commits on this run's own branch (`recordsRoot === workRoot`, `records.ts`'s
 * `record`), so the merge-base diff contains it; excluding it here is what keeps the design record out
 * of the diff's actual bytes, not only out of this node's input schema. Under the default `run-root`
 * policy nothing commits the record at all, so it is untracked and the exclusion is inert: nothing it
 * would have dropped was ever going to appear in this diff.
 */
const DESIGN_RECORD_EXCLUSION = `:(exclude)${DESIGN_DESTINATION.slice(0, DESIGN_DESTINATION.indexOf(TICKET_TOKEN))}**`

/** What the session must return: the description, and nothing that duplicates the diff. */
const VERDICT = verdictSchema(Schema.Struct({ description: Schema.String }))

/** Compiled fresh at dispatch, inside this node's own runtime — never at module load, never materialized as a file. */
const standardFor = (): string => compileChangelog(PR_BODY_PARAMS)

/**
 * Where this node's own diff was written and its line count: the facts the prompt states instead
 * of the diff itself, so prompt size never scales with diff size.
 */
interface DiffRef {
  readonly path: string
  readonly lines: number
}

/**
 * One line naming the diff file, then the compiled standard. This is the node's whole prompt: no
 * ticket, no title, no body, no review verdict — none of them is a field this node's input schema
 * carries. The design record is a fourth thing the prompt must not leak that *is* reachable through
 * the diff itself, so it is dropped at the source, by `DESIGN_RECORD_EXCLUSION`, before the patch
 * this prompt names is ever written.
 *
 * "Change nothing.": `review-diff/graph-node.ts`'s own review-prompt clause, carried here for the same reason
 * it exists there — `ClaudeAgent.prompt` has no tool allowlist, this session runs in the checkout
 * `push-branch` is about to push, and `guardCleanTree` fails the run on anything `git status
 * --porcelain` still reports.
 */
const promptFor = (diffRef: DiffRef): string =>
  `Write the pull request description for the diff at ${diffRef.path} (${diffRef.lines} lines): read every line, paging past any truncation notice. Change nothing.\n\n${standardFor()}`

/**
 * Writes the PR body from the branch's own diff, the last dispatch before `publish`. The session
 * that writes it has read nothing but the diff and the compiled standard: no ticket, no body, no
 * review verdict reach this node's `run` at all, and the design record is cut from the diff before
 * the patch is materialized, so the contract holds against what the session can actually read, not
 * just against this node's input schema.
 *
 * No head gate. `review-diff` and `prompt-terseness-evaluator` both require a declared `headSha`
 * because a caller who cannot name the tree does not know what it is asking about, but
 * `build-under-review` holds no settled head to declare. Widening two success schemas to enable a
 * guard for a failure no run has exhibited is what "no guards for failures never experienced"
 * rules out — this node reads `HEAD` itself instead, the same tree `push-branch` is about to push,
 * and returns the sha it diffed in its own success, so the journal records which tree the body
 * describes.
 */
export const writePrBody = make({
  name: "write-pr-body",
  description: "Write a pull request description from the branch's merge-base diff.",
  input: Schema.Struct({
    base: Schema.String,
    /** A named agent from the target repo's `.claude/agents/`, same convention as every other dispatching node's field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    /** The description as a run-root artifact, `pr-description-N.md`: the composer reads it from here, the journal records the path. */
    descriptionPath: Schema.String,
    /** The tree this description is about — the checkout's own `HEAD`, read by this node, not declared by a caller. */
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new PrBodyRunRootMissing())
      const cwd = workdir(runInfo)

      // The shared `git` helper (`runtime/git.ts`, PRINCIPLES.md's "a blocked sibling import
      // promotes the helper") trims stdout on success, which is exactly what a `rev-parse` read wants.
      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (info) => new PrBodyGitFailed(info))

      // The diff itself is read directly through `Shell`, not the shared helper: a diff must not be
      // trimmed — `trim()` eats a leading space off the first context line (`review-diff`'s own
      // precedent). The pathspec exclusion drops the design record before the bytes exist anywhere
      // this session can read them.
      const shell = yield* Shell
      const argv = ["git", "diff", `${input.base}...HEAD`, "--", DESIGN_RECORD_EXCLUSION] as const
      const diffed = yield* shell.run(argv, { cwd })
      if (diffed.exitCode !== 0) {
        return yield* Effect.fail(
          new PrBodyGitFailed({ argv: argv.join(" "), exitCode: diffed.exitCode, stderr: diffed.stderr.trim() })
        )
      }

      // Materialized in the run root before any session is dispatched: the prompt names a path
      // instead of carrying the diff's bytes on argv. A second `diff-*.patch` lands beside
      // `review-diff`'s own — `writeArtifact`'s prefix counter already proves it handles two nodes
      // sharing one prefix correctly (`review-diff`'s own multi-pass test).
      const fs = yield* FileSystem.FileSystem
      const diffPath = yield* writeArtifact(fs, runInfo.runRoot, "diff", diffed.stdout, "patch").pipe(
        Effect.catch((error) =>
          Effect.fail(new PrBodyDiffWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) }))
        )
      )
      const diffRef: DiffRef = {
        path: diffPath,
        // Same off-by-one fix as `review-diff`'s own count: strip exactly one trailing newline
        // before splitting, so an empty diff reads 0 lines rather than 1.
        lines: diffed.stdout === "" ? 0 : diffed.stdout.replace(/\n$/, "").split("\n").length
      }

      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: promptFor(diffRef),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const descriptionPath = yield* writeArtifact(fs, runInfo.runRoot, "pr-description", reply.verdict.description).pipe(
        Effect.catch((error) =>
          Effect.fail(new PrBodyDescriptionWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions }))
        )
      )

      return { descriptionPath, headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
