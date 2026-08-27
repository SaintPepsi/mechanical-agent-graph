import { Effect, Option, Schema } from "effect"
import { breakSuite } from "mag/graph-nodes/break/graph-node"
import { detectJsTests } from "mag/graph-nodes/detect-js-tests/graph-node"
import { judgeSeverity } from "mag/graph-nodes/judge-severity/graph-node"
import { testSmells } from "mag/graph-nodes/test-smells/graph-node"
import { verifyEscapes } from "mag/graph-nodes/verify-escapes/graph-node"
import { make } from "mag/runtime/graph-node.definition"
import { charge, NO_SPEND, type Spend } from "mag/runtime/spend"
import { RatedEscape } from "mag/runtime/suite-escape"
import { when } from "mag/runtime/when"

const Finding = Schema.Struct({
  path: Schema.String,
  severity: Schema.Literals(["error", "warn"]),
  rule: Schema.String,
  line: Schema.Int,
  message: Schema.String
})

/**
 * The review lane, built around the breaker: a mechanical sweep where the reader applies, then
 * `breakers` blind break attempts side by side (each read-only, so nothing they do can collide),
 * every claim proved or discarded by `verify-escapes`, and only the survivors rated. A false
 * positive is structurally impossible: nothing is reported that this process did not apply, run
 * and observe. The composite returns what it found and routes nowhere; a gate on the worst
 * severity is the caller's edge.
 */
export const adversarialReview = make({
  name: "adversarial-review",
  description: "Sweep the tests mechanically, dispatch blind breakers, verify every claim, and rate the escapes.",
  input: Schema.Struct({
    srcPaths: Schema.Array(Schema.String),
    testPaths: Schema.Array(Schema.String),
    /** The whole suite, `verify-escapes`'s command. */
    command: Schema.String,
    /** How many breakers to dispatch. */
    breakers: Schema.Int,
    /** Claims per breaker. */
    budget: Schema.Int,
    agent: Schema.optional(Schema.String),
    breakModel: Schema.optional(Schema.String),
    judgeModel: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    rated: Schema.Array(RatedEscape),
    smells: Schema.Array(Finding),
    claims: Schema.Int,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const agentField = input.agent === undefined ? {} : { agent: input.agent }
      let spent: Spend = NO_SPEND

      const swept = yield* when(detectJsTests, testSmells)({ probe: { testPaths: input.testPaths }, node: { testPaths: input.testPaths } })
      const smells = Option.match(swept, { onNone: () => [], onSome: (result) => result.findings })

      const broken = yield* Effect.all(
        Array.from({ length: input.breakers }, () =>
          breakSuite.run({
            srcPaths: input.srcPaths,
            testPaths: input.testPaths,
            budget: input.budget,
            ...agentField,
            ...(input.breakModel === undefined ? {} : { model: input.breakModel })
          })
        ),
        { concurrency: "unbounded" }
      )
      const claims = broken.flatMap((attempt) => attempt.claims)
      for (const attempt of broken) spent = charge(spent, attempt.sessions, attempt.costUsd)

      const verified = yield* verifyEscapes.run({ claims, command: input.command })
      const judged = yield* judgeSeverity.run({
        escapes: verified.escapes,
        ...agentField,
        ...(input.judgeModel === undefined ? {} : { model: input.judgeModel })
      })
      spent = charge(spent, judged.sessions, judged.costUsd)

      return { rated: judged.rated, smells, claims: claims.length, sessions: spent.sessions, costUsd: spent.costUsd }
    })
})
