import { Effect, FileSystem, Schema } from "effect"
import {
  TicketCriteriaUnreadable,
  TicketCriterionDropped,
  TicketDraftUnwritable,
  TicketInputNotOneSentence,
  TicketRunRootMissing
} from "mag/graph-nodes/write-ticket/errors"
import { droppedCriteria, isOneSentence, parseCriteriaLines } from "mag/graph-nodes/write-ticket/gate"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo } from "mag/runtime/run-info"
import { TicketSchema } from "mag/skills/ticket/schema"
import { compileTicketStandard } from "mag/skills/ticket/compose"
import { TICKET_STANDARD } from "mag/skills/ticket/variant"

/** What the session must return: the ticket's own structure — the reply schema IS the contract, never prose parsed after the fact. */
const TICKET = verdictSchema(TicketSchema)

/** The three sentences every gate and the prompt read, named once rather than respelled per helper. */
type Sentences = { readonly what: string; readonly why: string; readonly how: string }

const promptFor = (input: Sentences, criteria: readonly string[]): string =>
  [
    `What: ${input.what}`,
    `Why: ${input.why}`,
    `How: ${input.how}`,
    "",
    criteria.length > 0
      ? `Carry every one of these acceptance criteria into the ticket, verbatim in its own criterion's \`source\` field:\n${
        criteria.map((criterion) => `- ${criterion}`).join("\n")
      }`
      : "No acceptance criteria were provided; draw them from What/Why/How.",
    "",
    // Compiled fresh at dispatch, inside this node's own runtime: never at module load, never
    // materialized as a file.
    compileTicketStandard(TICKET_STANDARD)
  ].join("\n")

/** Reads and gates `criteriaPath` when given: one criterion per line, blank lines dropped, at least one left. Absent input is not a failure — an empty criteria list is a normal run. */
const readCriteria = (fs: FileSystem.FileSystem, path: string | undefined): Effect.Effect<readonly string[], TicketCriteriaUnreadable> =>
  path === undefined
    ? Effect.succeed([])
    : fs.readFileString(path).pipe(
      Effect.catch((error) => Effect.fail(new TicketCriteriaUnreadable({ path, detail: String(error) }))),
      Effect.flatMap((raw) => {
        const lines = parseCriteriaLines(raw)
        return lines.length === 0
          ? Effect.fail(new TicketCriteriaUnreadable({ path, detail: "no criterion on any line" }))
          : Effect.succeed(lines)
      })
    )

/** The one-sentence gate over all three inputs, field order, so the first offender is the one the caller sees. */
const gateInputs = (input: Sentences): Effect.Effect<void, TicketInputNotOneSentence> => {
  const offender = (["what", "why", "how"] as const).find((field) => !isOneSentence(input[field]))
  return offender === undefined
    ? Effect.void
    : Effect.fail(new TicketInputNotOneSentence({ field: offender, value: input[offender] }))
}

/**
 * Dispatches What/Why/How into a house-style ticket structure and drafts it to the run root. The
 * reply's schema is the ticket's own shape, so nothing downstream ever parses a paragraph — a reply
 * that survives neither `--json-schema` nor the transport's own retry never reaches this node's rail
 * at all.
 *
 * The draft is written to disk before the coverage check runs, not after: a dropped criterion still
 * leaves the run an artifact a human can read and fix by hand, and {@link TicketCriterionDropped}
 * names that path rather than a value nobody can reach once the failure has propagated.
 */
export const writeTicket = make({
  name: "write-ticket",
  description: "Dispatch What/Why/How into a house-style ticket structure and draft it to the run root.",
  input: Schema.Struct({
    what: Schema.String,
    why: Schema.String,
    how: Schema.String,
    /** One criterion per line; a list input can't coexist with a derived CLI command. */
    criteriaPath: Schema.optional(Schema.String),
    /** A named agent from the target repo's `.claude/agents/`, same convention as every other dispatching node's field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`: absent preserves today's behaviour. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    /** The draft as `ticket-N.json`: the filer reads it from here, and the journal records the path, never a second copy. */
    ticketPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new TicketRunRootMissing())

      yield* gateInputs(input)

      const fs = yield* FileSystem.FileSystem
      const criteria = yield* readCriteria(fs, input.criteriaPath)

      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: promptFor(input, criteria),
        jsonSchema: TICKET,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const ticketPath = yield* writeArtifact(
        fs,
        runInfo.runRoot,
        "ticket",
        JSON.stringify(reply.verdict, null, 2),
        "json"
      ).pipe(
        Effect.catch((error) => Effect.fail(new TicketDraftUnwritable({ runRoot: runInfo.runRoot, detail: String(error) })))
      )

      const missing = droppedCriteria(criteria, reply.verdict.acceptanceCriteria.map((criterion) => criterion.source))
      if (missing.length > 0) return yield* Effect.fail(new TicketCriterionDropped({ missing, ticketPath }))

      return { ticketPath, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
