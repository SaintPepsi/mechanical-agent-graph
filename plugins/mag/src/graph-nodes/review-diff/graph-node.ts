import { Effect, FileSystem, Schema } from "effect"
import {
  ReviewBlocked,
  ReviewDiffWriteFailed,
  ReviewDisputeIncomplete,
  ReviewDisputeRejected,
  ReviewFindingsWriteFailed,
  ReviewGitFailed,
  ReviewHeadMoved,
  ReviewRunRootMissing
} from "mag/graph-nodes/review-diff/errors"
import { governingPrinciples, nulPaths, PRINCIPLES_PATHSPEC } from "mag/graph-nodes/review-diff/principles"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { gitRead, gitReadRaw } from "mag/runtime/git"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { SWEEP_LABEL, SWEEP_TRIGGER } from "mag/skills/design/reference-sweep"

/** Blocking findings, an empty list a pass. */
const VERDICT = verdictSchema(Schema.Struct({ blocking: Schema.Array(Schema.String) }))

/**
 * The findings document's content: a pass still gets a file — "passing or
 * blocking" — because the run directory staying a complete per-pass record is worth one short file
 * even when there's nothing to flag. The first line names the sha this pass reviewed:
 * the artifact then states which tree its verdict is about, instead of a reader having to
 * infer it, and the build agent reading this file through its own `findingsPath` sees the
 * commit its findings were raised against stated, not inferred.
 */
const renderFindings = (headSha: string, blocking: readonly string[]): string =>
  [
    `Reviewed at ${headSha}`,
    "",
    blocking.length > 0 ? blocking.map((finding) => `- ${finding}`).join("\n") : "No blocking findings."
  ].join("\n")

/**
 * Where this pass's diff was written, the range it was taken from, and its line count:
 * the facts the prompt states instead of the diff itself. `range` is true because the head gate
 * above already proved `HEAD` is `headSha`; `lines` makes an under-read detectable by the reviewer
 * (the Read tool truncates at 2000 lines without erroring).
 */
interface DiffRef {
  readonly path: string
  readonly range: string
  readonly lines: number
}

/**
 * One line naming the diff file, replacing the inline `--- diff ---` section: prompt size
 * must not scale with diff size — E2BIG at `posix_spawn`. Kept terse: prompts are
 * model-authored and model-specific; only terse, concise instructions survive model change.
 */
const diffBlock = (diffRef: DiffRef): readonly string[] => [
  "",
  `Review the diff at ${diffRef.path} (${diffRef.lines} lines, \`git diff ${diffRef.range}\`) against the ticket: read every line, paging past any truncation notice, then reply with only the blocking findings, each specific enough to act on. Change nothing. An empty list means the diff passes.`
]

/** Unconditional splice, conditional in its own wording: the obligation only exists for a design record the diff already carries. */
const SWEEP_GATE: readonly string[] = [
  "",
  `When this diff ${SWEEP_TRIGGER} and carries a design record, that record states a ${SWEEP_LABEL}: the repo-wide grep for the old name and every hit, each hit owned by an edit in this diff or carrying a one-line reason its wording stays. A design record present without one is a blocking finding; a diff with no design record is nothing this gate checks.`
]

/**
 * The prompt lines naming the files that govern this diff, or none. Paths are
 * repo-root-relative, which is what git returned and what resolves from the session's cwd, so no
 * path composition happens here. The text names a category and a filename git says exists — never a
 * rule, a language, or a repository: that is a property of this function taking paths and
 * nothing else.
 */
const principlesBlock = (governing: readonly string[]): readonly string[] =>
  governing.length === 0 ? [] : [
    "",
    "This repository states engineering principles of its own, in the files below, each of which",
    "governs paths this diff touches:",
    ...governing.map((file) => `- ${file}`),
    "Read them and review the diff against what they say, alongside the ticket. A rule stated",
    "there that this diff breaks is a blocking finding, like any other."
  ]

/**
 * Rendered only when this pass is adjudicating a dispute (the caller's `run`
 * computed a `dispute` value from `findingsPath`/`disputePath`: a
 * prompt gate and an error-branch gate keyed on different conditions is the same "is this pass
 * adjudicating" question answered twice, and the two answers can disagree; both now read the one
 * value `run` derives). The one named exception to the reviewer's blindness,
 * never the build session, never a summary, but adjudicating requires this pass to see both
 * sides of the disagreement. Every review pass is a fresh session with no memory of any
 * prior pass, so the prompt cannot say "your prior findings", this session never had them, and
 * has to name the findings document itself, the same way it already names the dispute.
 *
 * Two callers can reach this block on trees that disagree about whether they moved, so the words below make no claim either way about tree identity.
 */
const disputeBlock = (findingsPath: string, disputePath: string): readonly string[] => [
  "",
  "A previous review pass raised blocking findings on this diff, recorded at",
  `${findingsPath}. The build pass that followed is recorded at ${disputePath}: it names the`,
  "finding(s) it disputes rather than fixed. This session has no memory of either pass, read both",
  "files alongside the diff file named above. Judge every finding from the findings document against",
  "what that diff actually shows now, not against what either document claims about it: a finding",
  "the dispute answers is settled if the dispute is right, and every other finding stands or falls",
  "on the diff as shown. Block on anything that still stands, as you would any other finding."
]

/**
 * This node is read-only by contract: it reports findings and changes nothing,
 * and that contract is what makes the backward edge sane: re-reviewing an unchanged diff only
 * re-finds the same items, so a blocking finding routes to the producer, never back here.
 *
 * A related rule — PRINCIPLES.md's "Probe before claiming runtime behaviour" — ships
 * nowhere in this prompt. That rule asks for evidence that the real thing was run, and this node is
 * handed the ticket and the diff only, never any record of what the producer ran, so it has nothing
 * to check the rule against. A check keying on something this node can see would be a different
 * rule, and wording it is a maintainer's call, not the reviewer's.
 */
const promptFor = (
  input: {
    readonly ticket: string
    readonly title: string
    readonly body: string
    readonly dispute?: { readonly findingsPath: string; readonly disputePath: string } | undefined
    readonly addendum?: string | undefined
  },
  diffRef: DiffRef,
  governing: readonly string[]
): string =>
  [
    `Ticket ${input.ticket}: ${input.title}`,
    "",
    input.body,
    ...diffBlock(diffRef),
    ...SWEEP_GATE,
    ...principlesBlock(governing),
    ...(input.dispute === undefined ? [] : disputeBlock(input.dispute.findingsPath, input.dispute.disputePath)),
    ...(input.addendum === undefined || input.addendum === "" ? [] : ["", input.addendum])
  ].join("\n")

/**
 * Reviews the branch diff against the ticket document. The diff is read
 * mechanically — `git diff <base>...HEAD`, three dots, which is git's own merge-base form — and
 * only the judgment goes to a model. A clean review succeeds; blocking findings are this node's
 * tagged error, which is what `build-under-review` feeds back to the producer.
 *
 * The findings are a run-root artifact, one file per pass, numbered by
 * `writeArtifact` counting this run's own prior `review-diff-*.md` files rather than by session id:
 * the number counts passes, so no pass can overwrite an earlier pass's findings whatever session
 * produced it.
 */
export const reviewDiff = make({
  name: "review-diff",
  description: "Review the branch diff against the ticket; block on findings that must be fixed.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    body: Schema.String,
    base: Schema.String,
    /**
     * The head the caller is gating: required, because a caller with no sha to
     * offer does not know which tree it is asking to be reviewed — `verification`'s own field, on
     * this node for the same reason (`verification/graph-node.ts`'s doc). Checked against the
     * checkout's own `HEAD` before any dispatch; a mismatch is {@link ReviewHeadMoved}, not a review.
     */
    headSha: Schema.String,
    /**
     * The findings a disputed build pass was answering, present alongside
     * `disputePath` on the adjudicating call. A single `dispute: { findingsPath, disputePath }`
     * struct field would make the half-set combination inexpressible at the schema boundary,
     * but this node's input has to stay a flat
     * struct of primitives: `deriveFlagSpecs` (`runtime/schema-flags.ts`) walks it into CLI flags,
     * and a nested `Schema.Struct` field fails that walk with `UNSUPPORTED_INPUT_SCHEMA` (probed
     * against the real CLI machinery). The two fields stay independently optional here; `run`
     * checks them together, first, before any other read, and fails
     * {@link ReviewDisputeIncomplete} on a half set rather than silently choosing a side. `review-diff`
     * is a fresh session with no memory of the pass that raised the findings, so the prompt
     * cannot say "your prior findings" — it has to name this document to give the model anything to
     * weigh the dispute against.
     */
    findingsPath: Schema.optional(Schema.String),
    /**
     * A build pass's dispute of the previous verdict, present alongside
     * `findingsPath` and checked against it the same way. Present makes this pass the decider: the
     * prompt names the file, and a blocking verdict is {@link ReviewDisputeRejected} rather than
     * {@link ReviewBlocked}, which ends the run instead of sending it back.
     */
    disputePath: Schema.optional(Schema.String),
    /** Extra instructions spliced into the prompt verbatim — same convention as `build`'s field. */
    addendum: Schema.optional(Schema.String),
    /**
     * A named agent from the target repo's `.claude/agents/` to run the session as, passed through
     * to the dispatch verbatim (same convention as `build`'s and `design`'s own field).
     */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    findingsPath: Schema.String,
    /** The tree this pass's verdict is about — the same value `headSha` declared. */
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      // One gate for "is this pass adjudicating a dispute," computed
      // once here and read by both the prompt block below and the error branch further down, so the
      // two can no longer disagree. A caller satisfying the schema with one of the pair set and the
      // other absent is a malformed input, not an ordinary block: it fails before any other read,
      // the same position `ReviewHeadMoved`'s gate holds, so it burns no session finding that out.
      if ((input.findingsPath === undefined) !== (input.disputePath === undefined)) {
        return yield* Effect.fail(
          new ReviewDisputeIncomplete({ findingsPath: input.findingsPath, disputePath: input.disputePath })
        )
      }
      const dispute = input.findingsPath === undefined || input.disputePath === undefined
        ? undefined
        : { findingsPath: input.findingsPath, disputePath: input.disputePath }

      const agent = yield* ClaudeAgent
      const fs = yield* FileSystem.FileSystem
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new ReviewRunRootMissing())
      const cwd = workdir(runInfo)

      // The gate sits above every other read and before any dispatch, so a tree that moved
      // out from under the caller's declared sha burns no session. `gitRead` trims the single
      // `rev-parse` line for us.
      const observed = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new ReviewGitFailed(fields))
      if (observed !== input.headSha) {
        return yield* Effect.fail(new ReviewHeadMoved({ expected: input.headSha, observed }))
      }

      const diffed = yield* gitReadRaw(
        ["git", "diff", `${input.base}...HEAD`],
        cwd,
        (fields) => new ReviewGitFailed(fields)
      )

      // Which PRINCIPLES.md files, if any, govern the paths this diff touches. Both reads
      // are comparisons between commits (or the index), so nothing about the working tree can make
      // them disagree with the diff already read above. `--no-renames` is load-bearing here: under
      // git's default rename detection, `--name-only` prints only the destination of a detected
      // rename, so a principles file that governed the source path would silently stop governing
      // (probed: `git mv`, then a plain `--name-only -z` diff, only the new path came back). The
      // diff shown to the reviewer above keeps its own rename detection; this is a different
      // question, "which paths did this diff touch," and both sides of a rename answer it.
      const changed = yield* gitReadRaw(
        ["git", "diff", "--no-renames", "--name-only", "-z", `${input.base}...HEAD`],
        cwd,
        (fields) => new ReviewGitFailed(fields)
      )
      const declared = yield* gitReadRaw(
        ["git", "ls-files", "-z", "--full-name", "--", ...PRINCIPLES_PATHSPEC],
        cwd,
        (fields) => new ReviewGitFailed(fields)
      )
      const governing = governingPrinciples(nulPaths(changed), nulPaths(declared))

      // The diff is materialised in the run root, before any session is dispatched, so the
      // prompt can name a path instead of carrying the bytes on argv (E2BIG at posix_spawn).
      // Placed after the git reads above, since a read that cannot answer
      // still costs no disk, and before the dispatch below, so the file is proven to exist before any
      // session is told about it.
      const diffPath = yield* writeArtifact(fs, runInfo.runRoot, "diff", diffed, "patch").pipe(
        Effect.catch((error) =>
          Effect.fail(new ReviewDiffWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) }))
        )
      )
      const diffRef = {
        path: diffPath,
        range: `${input.base}...${input.headSha}`,
        // `stdout` always ends in a trailing newline, and a bare
        // `split("\n")` counts the empty element after it, overcounting every diff by one — an
        // empty diff would read "1 lines", and a complete read would always fall one
        // line short of what the prompt below claims, the direction that makes a full read look
        // truncated. Strip exactly one trailing newline before splitting, so a diff with no
        // content is genuinely 0 lines.
        lines: diffed === "" ? 0 : diffed.replace(/\n$/, "").split("\n").length
      }

      const reply = yield* agent.prompt({
        prompt: promptFor({ ticket: input.ticket, title: input.title, body: input.body, dispute, addendum: input.addendum }, diffRef, governing),
        jsonSchema: VERDICT,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const findingsPath = yield* writeArtifact(
        fs,
        runInfo.runRoot,
        "review-diff",
        renderFindings(input.headSha, reply.verdict.blocking)
      ).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new ReviewFindingsWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions })
          )
        )
      )

      // One verdict, two ways to block. `dispute` (the same derived value the prompt
      // block above read) set means this pass is adjudicating, so a still-blocking verdict is the
      // deadlock, not an ordinary send-back.
      if (reply.verdict.blocking.length > 0) {
        return yield* Effect.fail(
          dispute === undefined
            ? new ReviewBlocked({ findingsPath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd })
            : new ReviewDisputeRejected({
              findingsPath,
              disputePath: dispute.disputePath,
              headSha: input.headSha,
              sessions: reply.sessions,
              costUsd: reply.costUsd
            })
        )
      }
      return { findingsPath, headSha: input.headSha, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
