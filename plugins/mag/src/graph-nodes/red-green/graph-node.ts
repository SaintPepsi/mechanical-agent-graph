import { Effect, Schema } from "effect"
import { assertRed } from "mag/graph-nodes/assert-red/graph-node"
import { implement } from "mag/graph-nodes/implement/graph-node"
import { pathsUntouched } from "mag/graph-nodes/paths-untouched/graph-node"
import { DeadTestAtBirth, HarnessError, StillRed } from "mag/graph-nodes/red-green/errors"
import { writeRed } from "mag/graph-nodes/write-red/graph-node"
import { make } from "mag/runtime/graph-node.definition"
import { charge, NO_SPEND, type Spend } from "mag/runtime/spend"
import { TestPlan } from "mag/runtime/test-plan"

/**
 * The words a send-back hands the next `write-red` pass. The tests are still committed, so the
 * pass rewrites in place and declares only what it changed.
 */
const rewriteAddendum = (verdict: DeadTestAtBirth | HarnessError): string =>
  verdict._tag === "DEAD_TEST_AT_BIRTH"
    ? `Already green at ${verdict.redSha}: ${verdict.green.join(", ")}. Each asserts nothing the current code gets wrong. Rewrite them so every test fails on its own assertion, and declare only the files you change.`
    : `Never ran at ${verdict.sha}: ${verdict.broken.join(", ")}. Fix what stops them running (a missing stub, an import, a syntax error) so each reaches its assertion and fails there, and declare only the files you change.`

/** The words a still-red verdict hands the resumed implementation session. */
const stillRedAddendum = (verdict: StillRed): string =>
  [
    ...(verdict.red.length === 0 ? [] : [`Still red at ${verdict.sha}: ${verdict.red.join(", ")}.`]),
    ...(verdict.broken.length === 0 ? [] : [`Still not running at ${verdict.sha}: ${verdict.broken.join(", ")}.`]),
    "Make them pass by editing source files only, then finish."
  ].join(" ")

const union = (a: readonly string[], b: readonly string[]): readonly string[] => [...new Set([...a, ...b])]

/**
 * Red-green as one composite over the error channel, `build-under-review`'s shape: two loops in
 * one generator, each capped, each routing a verdict this node mints from `assert-red`'s buckets.
 *
 * The red loop: `write-red` then `assert-red` at the red sha. Green there is a dead test at birth
 * and broken is a harness error; both go back to `write-red` with the evidence as its addendum,
 * because a test that cannot fail, or cannot run, is not yet a spec. Only an all-red set proceeds.
 *
 * The green loop: `implement`, then `paths-untouched` over the test paths from the red sha to the
 * new head (an implementation that edited a test has weakened it, which no loop repairs), then
 * `assert-red` again, where anything but all-green is `StillRed` and resumes the implementing
 * session. `TestDisputed` is never caught here: a session that argues with a test has raised a
 * disagreement a human settles, and it escapes upward whole.
 *
 * Test and stub paths accumulate across write passes, since a rewrite pass declares only what it
 * touched, and every assertion runs over the whole accumulated set.
 */
export const redGreen = make({
  name: "red-green",
  description: "Write red tests, prove them red, implement until green with the tests untouched, under a cap.",
  input: Schema.Struct({
    plan: TestPlan,
    headSha: Schema.String,
    /** `assert-red`'s per-path command, `$1` the test path. */
    testCommand: Schema.String,
    /** Max send-backs per loop: each of write-red and implement runs at most `cap + 1` times. */
    cap: Schema.Natural,
    agent: Schema.optional(Schema.String),
    writeModel: Schema.optional(Schema.String),
    implementModel: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    testPaths: Schema.Array(Schema.String),
    stubPaths: Schema.Array(Schema.String),
    redSha: Schema.String,
    headSha: Schema.String,
    /** Forward commits from the input head: the red commit(s) plus every implementation commit. */
    commits: Schema.Int,
    writePasses: Schema.Int,
    implementPasses: Schema.Int,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number),
    /** The implementing session, for a caller with a repair to dispatch against this head. */
    sessionRef: Schema.String
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agentField = input.agent === undefined ? {} : { agent: input.agent }
      const writeModelField = input.writeModel === undefined ? {} : { model: input.writeModel }
      const implementModelField = input.implementModel === undefined ? {} : { model: input.implementModel }
      let spent: Spend = NO_SPEND

      let current = input.headSha
      let testPaths: readonly string[] = []
      let stubPaths: readonly string[] = []
      let redSha = input.headSha
      let writePasses = 0
      let rewrite = undefined as DeadTestAtBirth | HarnessError | undefined
      while (true) {
        writePasses += 1
        const wrote = yield* writeRed.run({
          plan: input.plan,
          headSha: current,
          ...(rewrite === undefined ? {} : { addendum: rewriteAddendum(rewrite) }),
          ...agentField,
          ...writeModelField
        })
        spent = charge(spent, wrote.sessions, wrote.costUsd)
        testPaths = union(testPaths, wrote.testPaths)
        stubPaths = union(stubPaths, wrote.stubPaths)
        redSha = wrote.redSha

        const classified = yield* assertRed.run({ testPaths, sha: redSha, command: input.testCommand })
        if (classified.broken.length === 0 && classified.green.length === 0) break

        rewrite = classified.broken.length > 0
          ? new HarnessError({ broken: classified.broken, sha: redSha })
          : new DeadTestAtBirth({ green: classified.green, redSha })
        if (writePasses > input.cap) return yield* Effect.fail(rewrite)
        current = redSha
      }

      let head = redSha
      let producer = undefined as string | undefined
      let stillRed = undefined as StillRed | undefined
      let implementPasses = 0
      let commits = 0
      while (true) {
        implementPasses += 1
        const built = yield* implement.run({
          plan: input.plan,
          testPaths,
          headSha: head,
          ...(producer === undefined ? {} : { resume: producer }),
          ...(stillRed === undefined ? {} : { addendum: stillRedAddendum(stillRed) }),
          ...agentField,
          ...implementModelField
        })
        spent = charge(spent, built.sessions, built.costUsd)
        commits += built.commits
        yield* pathsUntouched.run({ paths: testPaths, fromSha: redSha, toSha: built.headSha })

        const classified = yield* assertRed.run({ testPaths, sha: built.headSha, command: input.testCommand })
        if (classified.red.length === 0 && classified.broken.length === 0) {
          return {
            testPaths,
            stubPaths,
            redSha,
            headSha: built.headSha,
            commits: commits + writePasses,
            writePasses,
            implementPasses,
            sessions: spent.sessions,
            costUsd: spent.costUsd,
            sessionRef: built.sessionRef
          }
        }
        stillRed = new StillRed({ red: classified.red, broken: classified.broken, sha: built.headSha })
        if (implementPasses > input.cap) return yield* Effect.fail(stillRed)
        head = built.headSha
        producer = built.sessionRef
      }
    })
})
