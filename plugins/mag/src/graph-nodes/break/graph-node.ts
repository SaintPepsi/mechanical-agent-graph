import { Effect, Schema } from "effect"
import { BreakNoSources } from "mag/graph-nodes/break/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Claim } from "mag/runtime/suite-escape"

/**
 * The budget is enforced by the verdict schema, not by a count after the fact: `maxItems` reaches
 * the model as part of the contract, and an overrun fails the decode at the transport rather than
 * being trimmed here.
 */
const verdictFor = (budget: number) =>
  verdictSchema(Schema.Struct({ claims: Schema.Array(Claim).check(Schema.isMaxLength(budget)) }))

/**
 * Severity-targeted: the worst classes are named first, so the budget is spent where an escape
 * would matter. The session is read-only; every claim is unverified until `verify-escapes` runs it.
 */
const promptFor = (srcPaths: readonly string[], testPaths: readonly string[], budget: number): string =>
  [
    `Break the code in ${srcPaths.join(", ")} without the tests in ${testPaths.join(", ")} noticing. Read only, change nothing on disk.`,
    `Reply with at most ${budget} claims. Each claim: one \`find\` string occurring exactly once in \`path\`, its \`replace\`, a \`rationale\` naming the behaviour it changes, and \`probeSource\`, a POSIX sh script run from the repository root whose stdout differs before and after the replacement while every test still passes.`,
    "Target the worst bug first: data loss, one caller seeing another's state, a write that stops persisting, then a wrong limit, then a boundary."
  ].join("\n")

/**
 * One blind breaker. Emits claims only: a claim is the model's word, and the lane's whole design
 * is that its word is never the verdict. Ticket-blind by construction (paths in, claims out), so
 * the breaker attacks the code as shipped rather than what the ticket says it should do.
 */
export const breakSuite = make({
  name: "break",
  description: "Dispatch one blind breaker to claim mutations the given tests would miss.",
  input: Schema.Struct({
    srcPaths: Schema.Array(Schema.String),
    testPaths: Schema.Array(Schema.String),
    /** Most claims one breaker may return; the verdict schema carries it as `maxItems`. */
    budget: Schema.Int,
    /** A named agent from the target repo's `.claude/agents/`, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    claims: Schema.Array(Claim),
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      if (input.srcPaths.length === 0) return yield* Effect.fail(new BreakNoSources())
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const reply = yield* agent.prompt({
        prompt: promptFor(input.srcPaths, input.testPaths, input.budget),
        jsonSchema: verdictFor(input.budget),
        cwd: workdir(runInfo),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })
      return { claims: reply.verdict.claims, sessions: reply.sessions, costUsd: reply.costUsd }
    })
})
