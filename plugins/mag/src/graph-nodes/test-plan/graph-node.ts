import { Effect, Schema } from "effect"
import { TestPlanAcsEmpty } from "mag/graph-nodes/test-plan/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { TestPlan } from "mag/runtime/test-plan"

/** At least one test, each with a named bug: both are the schema's to refuse, not the prompt's to ask for. */
const VERDICT = verdictSchema(Schema.Struct({ plan: TestPlan.check(Schema.isMinLength(1)) }))

/**
 * The negative-space checklist runs as spec elicitation here, before any test is written: each
 * entry names what the code promises not to do, so the tests pin the contract's silence as well
 * as its statements.
 */
const promptFor = (acs: readonly string[], discoverPath: string): string =>
  [
    `Plan the tests that prove these acceptance criteria. Read ${discoverPath} for what already exists, then the code it names. Read only.`,
    ...acs.map((criterion) => `- ${criterion}`),
    "Reply with one entry per test: `name` (the behaviour and its condition), `behaviour` (what the test proves), `bugItCatches` (the one-line wrong implementation this test goes red on), `negativeSpace` (what the code promises not to do that this test pins: input left unchanged, a repeated call safe, no case folded, no extra separator accepted, paired operations agreeing at the same boundary).",
    "Choose values a wrong formula cannot pass by coincidence: an odd nonzero clock, two or three elements where count matters, every field of an expected object distinct."
  ].join("\n")

/**
 * The lane's first model step. Ticket-blind: it sees criteria and a recon note, never the ticket,
 * so the plan is about behaviour rather than about satisfying a description. The plan travels
 * inline in the success: it is bounded by the number of tests, small by construction.
 */
export const testPlan = make({
  name: "test-plan",
  description: "Plan one red test per behaviour the acceptance criteria demand, each with the bug it catches named.",
  input: Schema.Struct({
    acs: Schema.Array(Schema.String),
    /** The recon note `discover` wrote, so the plan reads what exists before deciding what to prove. */
    discoverPath: Schema.String,
    /** A named agent from the target repo's `.claude/agents/`, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    plan: TestPlan,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      if (input.acs.length === 0) return yield* Effect.fail(new TestPlanAcsEmpty())
      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const reply = yield* agent.prompt({
        prompt: promptFor(input.acs, input.discoverPath),
        jsonSchema: VERDICT,
        cwd: workdir(runInfo),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })
      return { plan: reply.verdict.plan, sessions: reply.sessions, costUsd: reply.costUsd }
    })
})
