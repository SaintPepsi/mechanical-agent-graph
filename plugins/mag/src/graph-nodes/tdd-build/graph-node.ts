import { Effect, FileSystem, Schema } from "effect"
import { adversarialReview } from "mag/graph-nodes/adversarial-review/graph-node"
import { redGreen } from "mag/graph-nodes/red-green/graph-node"
import { TddBuildEscapeUnresolved, TddBuildGitFailed, TddBuildRunRootMissing, TddBuildSummaryWriteFailed } from "mag/graph-nodes/tdd-build/errors"
import { testPlan } from "mag/graph-nodes/test-plan/graph-node"
import { verification } from "mag/graph-nodes/verification/graph-node"
import { writeArtifact } from "mag/runtime/artifact"
import { make } from "mag/runtime/graph-node.definition"
import { gitRead } from "mag/runtime/git"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { charge, NO_SPEND, type Spend } from "mag/runtime/spend"
import { maxSeverity, type RatedEscape } from "mag/runtime/suite-escape"
import { type TestPlan } from "mag/runtime/test-plan"

/** Severity at or above this routes an escape back as the next red test's spec. */
const ROUTE_AT = 2

/** A verified escape rendered as the one criterion the next round plans against. */
const escapeSpec = (escape: RatedEscape): string =>
  `A verified ${escape.category} escape: in ${escape.path}, replacing \`${escape.find}\` with \`${escape.replace}\` changes behaviour (probe: \`${escape.probeSource}\`) while every test still passes. Add the test that goes red on that replacement.`

/** The worst escape, first among equals, the one the next round is about. */
const worstOf = (rated: ReadonlyArray<RatedEscape>): RatedEscape =>
  rated.reduce((worst, escape) => (escape.severity > worst.severity ? escape : worst))

const renderSummary = (rounds: ReadonlyArray<{ plan: TestPlan; rated: ReadonlyArray<RatedEscape>; smells: number }>): string =>
  rounds
    .map((round, index) =>
      [
        `## Round ${index + 1}`,
        "",
        ...round.plan.map((entry) => `- ${entry.name} (catches: ${entry.bugItCatches})`),
        "",
        round.rated.length === 0 ? "No verified escapes." : round.rated.map((escape) => `- [${escape.severity}] ${escape.category}: ${escape.path} \`${escape.find}\` -> \`${escape.replace}\``).join("\n"),
        round.smells === 0 ? "" : `${round.smells} mechanical smell(s) in the tests.`
      ].join("\n")
    )
    .join("\n\n")

/**
 * The TDD lane end to end: `test-plan` from the criteria, `red-green` to a green tree with the
 * tests untouched, `verification` over the whole suite, then the review lane borrowed whole. A
 * verified escape rated {@link ROUTE_AT} or worse becomes the next round's only criterion, so the
 * missing test gets written red-first like any other, under a cap; when the cap is spent with a
 * severe escape still open the loop ends on {@link TddBuildEscapeUnresolved}. Anything milder is
 * reported in the summary and the ledger and does not route.
 *
 * Ticket-blind: criteria, a recon note, shas and commands in. Source paths for the breakers are
 * measured from git (everything the branch changed that is not a declared test), never declared.
 * `TestDisputed` passes through untouched: a human settles it.
 */
export const tddBuild = make({
  name: "tdd-build",
  description: "Plan tests from the criteria, build red-green under a cap, verify, and close verified escapes by routing them back as specs.",
  input: Schema.Struct({
    acs: Schema.Array(Schema.String),
    discoverPath: Schema.String,
    base: Schema.String,
    /** The whole suite, `verification`'s command. */
    command: Schema.String,
    /** `assert-red`'s per-path command, `$1` the test path. */
    testCommand: Schema.String,
    /** Max escape rounds after the first: the plan runs at most `cap + 1` times. */
    cap: Schema.Natural,
    /** `red-green`'s own send-back cap, per loop. */
    redGreenCap: Schema.Natural,
    breakers: Schema.Int,
    budget: Schema.Int,
    agent: Schema.optional(Schema.String),
    planModel: Schema.optional(Schema.String),
    writeModel: Schema.optional(Schema.String),
    implementModel: Schema.optional(Schema.String),
    breakModel: Schema.optional(Schema.String),
    judgeModel: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    headSha: Schema.String,
    summaryPath: Schema.String,
    commits: Schema.Int,
    testPaths: Schema.Array(Schema.String),
    rounds: Schema.Int,
    /** Verified escapes left open at the end, all milder than the routing threshold. */
    escapes: Schema.Int,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number),
    /** The last implementing session, for a caller with a repair to dispatch against this head. */
    sessionRef: Schema.String
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new TddBuildRunRootMissing())
      const cwd = workdir(runInfo)
      const fail = (fields: { argv: string; exitCode: number; stderr: string }) => new TddBuildGitFailed(fields)
      const agentField = input.agent === undefined ? {} : { agent: input.agent }
      const modelField = (model: string | undefined) => (model === undefined ? {} : { model })

      const before = yield* gitRead(["git", "rev-parse", "HEAD"], cwd, fail)
      let spent: Spend = NO_SPEND
      let spec = input.acs
      let current = before
      let testPaths: readonly string[] = []
      let sessionRef = ""
      const rounds: Array<{ plan: TestPlan; rated: ReadonlyArray<RatedEscape>; smells: number }> = []

      while (true) {
        const planned = yield* testPlan.run({ acs: spec, discoverPath: input.discoverPath, ...agentField, ...modelField(input.planModel) })
        spent = charge(spent, planned.sessions, planned.costUsd)

        const built = yield* redGreen.run({
          plan: planned.plan,
          headSha: current,
          testCommand: input.testCommand,
          cap: input.redGreenCap,
          ...agentField,
          ...(input.writeModel === undefined ? {} : { writeModel: input.writeModel }),
          ...(input.implementModel === undefined ? {} : { implementModel: input.implementModel })
        })
        spent = charge(spent, built.sessions, built.costUsd)
        testPaths = [...new Set([...testPaths, ...built.testPaths])]
        sessionRef = built.sessionRef
        current = built.headSha

        yield* verification.run({ command: input.command, headSha: current })

        const changed = yield* gitRead(["git", "diff", "--name-only", `${input.base}...HEAD`], cwd, fail)
        const declared = new Set(testPaths)
        const srcPaths = changed.split("\n").filter((path) => path !== "" && !declared.has(path))
        const reviewed = yield* adversarialReview.run({
          srcPaths,
          testPaths,
          command: input.command,
          breakers: input.breakers,
          budget: input.budget,
          ...agentField,
          ...(input.breakModel === undefined ? {} : { breakModel: input.breakModel }),
          ...(input.judgeModel === undefined ? {} : { judgeModel: input.judgeModel })
        })
        spent = charge(spent, reviewed.sessions, reviewed.costUsd)
        rounds.push({ plan: planned.plan, rated: reviewed.rated, smells: reviewed.smells.length })

        if (maxSeverity(reviewed.rated) < ROUTE_AT) {
          const fs = yield* FileSystem.FileSystem
          const summaryPath = yield* writeArtifact(fs, runInfo.runRoot, "tdd-build", renderSummary(rounds)).pipe(
            Effect.catch((error) => Effect.fail(new TddBuildSummaryWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) })))
          )
          const counted = yield* gitRead(["git", "rev-list", "--count", `${before}..HEAD`], cwd, fail)
          const commits = Number(counted)
          if (!Number.isInteger(commits)) {
            return yield* Effect.fail(fail({ argv: `git rev-list --count ${before}..HEAD`, exitCode: 0, stderr: counted }))
          }
          return {
            headSha: current,
            summaryPath,
            commits,
            testPaths,
            rounds: rounds.length,
            escapes: reviewed.rated.length,
            sessions: spent.sessions,
            costUsd: spent.costUsd,
            sessionRef
          }
        }

        const worst = worstOf(reviewed.rated)
        if (rounds.length > input.cap) {
          return yield* Effect.fail(new TddBuildEscapeUnresolved({ escape: worst, rounds: rounds.length, headSha: current }))
        }
        spec = [escapeSpec(worst)]
      }
    }).pipe(Effect.provide(platform))
})
