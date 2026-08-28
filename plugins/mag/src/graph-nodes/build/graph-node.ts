import { Effect, FileSystem, Schema } from "effect"
import {
  BuildCommitFailed,
  BuildDisputed,
  BuildGitFailed,
  BuildHeadMoved,
  BuildNoCommits,
  BuildResumeEmpty,
  BuildRunRootMissing,
  BuildSummaryEmpty,
  BuildSummaryWriteFailed,
  BuildWorkdirDirty
} from "mag/graph-nodes/build/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { commitAgentLeftovers, gitRead, gitReadRaw } from "mag/runtime/git"
import { platform } from "mag/runtime/platform"
import { dirtyPaths } from "mag/runtime/porcelain"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { ticketReference } from "mag/runtime/ticket"

/**
 * What the agent must return; `decode` enforces the same contract `--json-schema` shows it.
 * `dispute` is `Schema.optionalKey`, not `optional`, checked against `verdictSchema`'s `serialized`
 * output: `optional` would show the model `anyOf: [string, null]` on every ordinary pass, inviting
 * an explicit null where there is nothing to say.
 */
const SUMMARY = verdictSchema(Schema.Struct({ summary: Schema.String, dispute: Schema.optionalKey(Schema.Array(Schema.String)) }))

/**
 * Build stays design-ignorant: no design diff belongs here regardless of caller. The framing treats
 * the reviewer's findings as claims the agent must address or rebut, never simply accept on faith.
 */
const sendBackBlock = (findingsPath: string): readonly string[] => [
  "",
  "A reviewer examined this branch's previous attempt and found blocking problems, recorded at",
  `${findingsPath}. Read that file and address every finding: commit a fix for each one that needs`,
  "a change, and for any that need none — already fixed, or wrong — quote the finding in your",
  "reply's `dispute` list with the reason, instead of inventing a change to satisfy it. An empty",
  "list means nothing is disputed. A single pass may commit fixes and dispute the rest.",
  "When addressing a finding adds an input or a failure condition, re-derive the contract in the",
  "same commit — the declared inputs and failure modes the change widens, and the documents that",
  "record them — and say so in your reply."
]

/**
 * The fixed charge of every pass; a line earns its place here only once a session proves it
 * missing, not by default growth. No suite command travels here: verification is a mechanical
 * loopback owned by the caller now, not a sentence a session is trusted to act on.
 *
 * A resumed pass drops the ticket framing (title, ticket reference, branch, "implement what the
 * ticket asks") because the session already holds it, and restating it invites a re-implementation
 * from scratch rather than a fix. The standing discipline is not framing, though, so it renders on
 * resumed passes too: every caller gets the acceptance-criterion proof sentence, and every caller
 * gets the artifact-write sentence. The passes that fix a finding are the ones most in need of
 * being charged to prove the fix.
 */
const promptFor = (input: {
  readonly ticket: string
  readonly title: string
  readonly ticketPath: string
  readonly branch: string
  readonly resume?: string | undefined
  readonly findingsPath?: string | undefined
  readonly addendum?: string | undefined
}): string =>
  [
    ...(input.resume !== undefined ? [] : [
      ...ticketReference(input),
      "",
      `You are on branch \`${input.branch}\` in this repository's working tree. Implement what the`,
      "ticket asks for: gather your own context from the repository, make the change, and commit",
      "your work with git. Reply with a short summary of what you did."
    ]),
    "Prove each acceptance criterion with a test that executes the exported symbol that ships, and",
    "name in your summary the one-line edit to the shipped module that would make that test fail.",
    "Write every artifact in its final state: a comment is one line stating a constraint the code",
    "cannot show, never a ticket citation, and a correction rewrites the prose it affects in place.",
    ...(input.findingsPath === undefined ? [] : sendBackBlock(input.findingsPath)),
    ...(input.addendum === undefined || input.addendum === "" ? [] : ["", input.addendum])
  ].join("\n").trimStart()

/**
 * The dispute artifact's content: the findings file it answers, named on the first line so the
 * document is self-describing to whoever reads it next — the adjudicating review pass, or a human
 * — without having to infer which verdict this is a reply to.
 */
const disputeContentFor = (findingsPath: string, dispute: readonly string[]): string =>
  [`Disputes ${findingsPath}`, "", ...dispute.map((line) => `- ${line}`)].join("\n")

/**
 * The dispute gate and write, shared by both of `build`'s endings; `commits === 0` is not this
 * function's question. Built on this module's own shared `gitRead`/`gitReadRaw` seam rather than a
 * local `git`/`gitStatusPorcelain` pair: the read shape is identical, so folding a caller's own
 * dispute-gate split onto this one stays a rename, not a redesign.
 */
const recordDispute = (
  runRoot: string,
  findingsPath: string | undefined,
  dispute: readonly string[] | undefined,
  sessions: readonly string[]
): Effect.Effect<
  { readonly findingsPath: string; readonly disputePath: string } | undefined,
  BuildSummaryWriteFailed,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    // Blank entries are silence, not an argument: only a quoted finding counts as disputed.
    const quoted = (dispute ?? []).filter((line) => line.trim() !== "")
    if (findingsPath === undefined || quoted.length === 0) return undefined
    const fs = yield* FileSystem.FileSystem
    const disputePath = yield* writeArtifact(fs, runRoot, "dispute", disputeContentFor(findingsPath, quoted)).pipe(
      Effect.catch((error) => Effect.fail(new BuildSummaryWriteFailed({ runRoot, detail: String(error), sessions })))
    )
    return { findingsPath, disputePath }
  })

/**
 * Composes the salvage commit's message. The subject names the run's own ticket, not the ticket of
 * the mechanism that wrote the message: the emitted string ships into a consuming repo's git
 * history, where this pipeline's own ticket number carries no meaning. The body names the node as
 * author. One `Claude-Session` trailer per session in the reply carries the same attribution the
 * journal row does — the same convention manual salvage commits already use, reused rather than
 * invented here.
 */
const commitMessageFor = (ticket: string, sessions: readonly string[]): string =>
  [
    `${ticket}: work committed by the build node`,
    "",
    "The build session finished without committing, so the build node staged and",
    "committed what it left in the working tree.",
    "",
    ...sessions.map((session) => `Claude-Session: ${session}`)
  ].join("\n")

/**
 * Runs the coding agent on the checked-out fix branch, then verifies mechanically that it actually
 * committed something: the reply's own summary is a map, the branch is the territory. The baseline
 * is measured here, immediately before the agent runs, rather than piped in from the `branch`
 * node — a replayed predecessor row would carry a stale sha, and a stale baseline miscounts. The
 * resulting `headSha` is measured the same way, immediately after: a caller chaining `verification`
 * straight after this node needs the tree it just produced, not the tree `before` names — see
 * `verification/graph-node.ts`'s doc comment for the failure this prevents.
 *
 * The reply's `sessions` and `costUsd` pass straight into the success value, so the journal row
 * records them with no schema change.
 *
 * Right beside the baseline, before any agent spend, a second probe fails `BuildWorkdirDirty` if the
 * tree is already dirty: `commitAgentLeftovers`'s `git add -A` cannot tell the run's own leftovers
 * from dirt that predates the session, so a live checkout with unrelated changes sitting in it
 * refuses here instead of folding that dirt into a commit that claims to be this ticket's work.
 * Worktree mode gives every run a tree nothing else can dirty, so this guard is a no-op there by
 * construction.
 *
 * Between the artifact write and the count, `commitAgentLeftovers` mechanically salvages a session
 * that finished its work but refused the prompt's own request to commit it: the prompt keeps
 * asking, but the node no longer depends on the answer. It runs after the artifact so a failed
 * write leaves the tree exactly as today's failure leaves it, and before `commits`/`headSha` so both
 * measurements are downstream of the commit by position, which is what keeps them honest. Scoped to
 * the whole tree rather than a path list because this node's reply schema is `{ summary }` and
 * always has been — asking the session a second question it already ended without answering would
 * be the exact map-for-territory substitution this node exists to avoid.
 *
 * The summary is a run-root artifact, not inline prose: the node writes `reply.verdict.summary` to
 * its own computed path and returns the reference, so the journal row and any downstream prompt
 * carry a path instead of a duplicated copy of the text — an oversized prompt otherwise dies at
 * `execve`. Unlike `design`, this node authors the content itself from a reply it already holds, so
 * the mechanical guarantee this needs is "the string was non-empty before the write, and the write
 * effect itself didn't fail" — re-reading a file this same process just wrote would prove nothing a
 * successful `Effect` didn't already prove.
 */
export const build = make({
  name: "build",
  description: "Run the coding agent on the fix branch until it has committed work.",
  input: Schema.Struct({
    ticket: Schema.String,
    title: Schema.String,
    ticketPath: Schema.String,
    branch: Schema.String,
    /**
     * Extra instructions from whoever invokes this node, spliced into the prompt verbatim. The node
     * stays ignorant of why they exist — a review loop's send-back framing, a repair loop's
     * verification report, or anything else a graph needs to say, so the caller owns the words, and
     * the words are journal-recorded because they travel as input.
     */
    addendum: Schema.optional(Schema.String),
    /**
     * The blocking verdict this pass is answering. Present means a send-back pass: the prompt names
     * the file, and a zero-commit session may end in a dispute instead of {@link BuildNoCommits}.
     * Absent means a first pass, where absent work is still an error: `recordDispute` files a
     * dispute only when this field is present, whatever the reply says.
     */
    findingsPath: Schema.optional(Schema.String),
    /**
     * The session this pass resumes: `--resume`, passed straight to the transport. Present means the
     * prompt carries only the standing discipline every pass carries plus this pass's own
     * instruction, `findingsPath` and/or `addendum`, and drops the ticket reference and the branch
     * line, because the session already holds those. Absent means an ordinary fresh dispatch.
     */
    resume: Schema.optional(Schema.String),
    /**
     * A named agent from the target repo's `.claude/agents/` to run the session as, passed through
     * to the dispatch verbatim. The graph wires it — develop-graph hardwires effect-expert, other
     * graphs pass nothing — so this node stays one node, not a fork per agent.
     */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    summaryPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number),
    commits: Schema.Int,
    /**
     * The commit this pass left `HEAD` on, measured the same way as `before` — immediately, by
     * this node, never piped in. A caller that runs `verification` straight after this node
     * (`build-under-review`) needs this to identify the tree it is about to verify:
     * `verification`'s journaled input has to carry it, or a resumed run can replay a stale
     * verification row over a tree this same pass just rewrote.
     */
    headSha: Schema.String,
    /** Present together: the findings this pass answered and the dispute it filed. */
    findingsPath: Schema.optional(Schema.String),
    disputePath: Schema.optional(Schema.String),
    /**
     * The session a caller can resume to repair this pass's own head: the reply's pinned id,
     * `reply.sessions[0]` (`runtime/claude/agent.ts`'s `pinned` id, stable across resumes), returned as a
     * named field rather than left for a caller to infer from array order.
     */
    sessionRef: Schema.String
  }),
  run: (input) =>
    Effect.gen(function* () {
      // Checked before any read at all: the cheapest position for the shape `errors.ts` describes.
      if (input.resume !== undefined && input.findingsPath === undefined && input.addendum === undefined) {
        return yield* Effect.fail(new BuildResumeEmpty())
      }

      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new BuildRunRootMissing())
      const cwd = workdir(runInfo)

      const before = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new BuildGitFailed(fields))
      const preStatus = yield* gitReadRaw(["git", "status", "--porcelain"], cwd, (fields) => new BuildGitFailed(fields))
      const preDirty = dirtyPaths(preStatus)
      if (preDirty.length > 0) return yield* Effect.fail(new BuildWorkdirDirty({ paths: preDirty }))

      const reply = yield* agent.prompt({
        prompt: promptFor(input),
        jsonSchema: SUMMARY,
        cwd,
        ...(input.resume === undefined ? {} : { resume: input.resume }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      if (reply.verdict.summary.trim() === "") {
        return yield* Effect.fail(new BuildSummaryEmpty({ sessions: reply.sessions }))
      }
      const fs = yield* FileSystem.FileSystem
      const summaryPath = yield* writeArtifact(fs, runInfo.runRoot, "build", reply.verdict.summary).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new BuildSummaryWriteFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions })
          )
        )
      )

      // Recorded before anything about git is measured, so both endings below read one value.
      const dispute = yield* recordDispute(runInfo.runRoot, input.findingsPath, reply.verdict.dispute, reply.sessions)

      yield* commitAgentLeftovers(
        cwd,
        commitMessageFor(input.ticket, reply.sessions),
        reply.sessions,
        (fields) => new BuildGitFailed(fields),
        (fields) => new BuildCommitFailed(fields)
      )

      const counted = yield* gitRead(
        ["git", "rev-list", "--count", `${before}..HEAD`],
        cwd,
        (fields) => new BuildGitFailed(fields)
      )

      const commits = Number(counted)
      if (!Number.isInteger(commits)) {
        return yield* Effect.fail(
          new BuildGitFailed({ argv: `git rev-list --count ${before}..HEAD`, exitCode: 0, stderr: counted })
        )
      }

      // `commits > 0` falls through unchanged below; a zero count without a recorded dispute is `BuildNoCommits`.
      if (commits === 0) {
        if (dispute === undefined) {
          return yield* Effect.fail(new BuildNoCommits({ commits }))
        }
        const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new BuildGitFailed(fields))
        // `git rev-list --count before..HEAD === 0` means HEAD is not ahead of `before`, not that
        // HEAD is `before` — a session that moved HEAD backward (e.g. `git reset --hard HEAD~1`)
        // still counts zero forward commits while leaving a different tree than the one this run's
        // previous pass verified. The assumption that a pass with zero commits leaves HEAD where the
        // previous pass left it only holds when `headSha` equals `before`, so that is checked here
        // rather than assumed: a mismatch is `BuildHeadMoved`, named for what happened rather than
        // folded into `BuildNoCommits` — the branch lost commits and the previously-verified tree is
        // gone, the opposite of "the agent did nothing," and a human reading the escalated failure
        // needs to be able to tell the two apart.
        if (headSha !== before) {
          return yield* Effect.fail(new BuildHeadMoved({ expected: before, observed: headSha }))
        }
        return yield* Effect.fail(
          new BuildDisputed({
            summaryPath,
            disputePath: dispute.disputePath,
            findingsPath: dispute.findingsPath,
            headSha,
            commits,
            sessions: reply.sessions,
            costUsd: reply.costUsd
          })
        )
      }

      const headSha = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, (fields) => new BuildGitFailed(fields))

      // The pair rides an ordinary success too, not only BuildDisputed. `sessionRef` is
      // `reply.sessions[0]`, the pinned id: stable whether this pass was fresh or resumed.
      return {
        summaryPath,
        sessions: reply.sessions,
        costUsd: reply.costUsd,
        commits,
        headSha,
        sessionRef: reply.sessions[0]!,
        ...(dispute ?? {})
      }
    }).pipe(Effect.provide(platform))
})
