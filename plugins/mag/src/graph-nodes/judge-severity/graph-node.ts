import { Effect, FileSystem, Schema } from "effect"
import {
  SeverityEscapesWriteFailed,
  SeverityRatingsIncomplete,
  SeverityRunRootMissing
} from "mag/graph-nodes/judge-severity/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { ESCAPE_CATEGORIES, Escape, RatedEscape, severityOf } from "mag/runtime/suite-escape"

/**
 * One category per index, from the closed list: the model never emits a number. Severity is
 * `severityOf`'s lookup on what it picked (`runtime/suite-escape.ts`'s table).
 */
const VERDICT = verdictSchema(
  Schema.Struct({
    ratings: Schema.Array(Schema.Struct({ index: Schema.Int, category: Schema.Literals(ESCAPE_CATEGORIES) }))
  })
)

const promptFor = (escapesPath: string, count: number): string =>
  [
    `Rate the ${count} verified escapes in ${escapesPath}: each is a mutation to shipped code that every test missed, indexed from 0. Read only.`,
    `Reply with one rating per index, choosing the category naming the worst consequence the mutation can have: ${ESCAPE_CATEGORIES.join(", ")}.`
  ].join("\n")

/** Indexes rated fewer or more than exactly once, for {@link SeverityRatingsIncomplete}. */
const coverage = (count: number, ratings: ReadonlyArray<{ readonly index: number }>) => {
  const seen = new Map<number, number>()
  for (const rating of ratings) seen.set(rating.index, (seen.get(rating.index) ?? 0) + 1)
  const missing = Array.from({ length: count }, (_, index) => index).filter((index) => !seen.has(index))
  const duplicated = [...seen].filter(([, times]) => times > 1).map(([index]) => index)
  return { missing, duplicated }
}

/**
 * Blind rating: the judge sees the mutation, the probe and nothing the breaker wrote about it,
 * and answers with a word from a closed list. The escapes travel as a run-root file rather than
 * inline, so the prompt does not scale with how many there are. No escapes means no dispatch:
 * an empty rating is a fact, not a session.
 */
export const judgeSeverity = make({
  name: "judge-severity",
  description: "Have a blind judge categorise each verified escape; severity is a table lookup on the category.",
  input: Schema.Struct({
    escapes: Schema.Array(Escape),
    /** A named agent from the target repo's `.claude/agents/`, same convention as `build`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    rated: Schema.Array(RatedEscape),
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      if (input.escapes.length === 0) return { rated: [], sessions: [], costUsd: 0 }
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new SeverityRunRootMissing())

      const fs = yield* FileSystem.FileSystem
      const escapesPath = yield* writeArtifact(fs, runInfo.runRoot, "escapes", JSON.stringify(input.escapes, null, 2), "json").pipe(
        Effect.catch((error) => Effect.fail(new SeverityEscapesWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) })))
      )

      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: promptFor(escapesPath, input.escapes.length),
        jsonSchema: VERDICT,
        cwd: workdir(runInfo),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const { missing, duplicated } = coverage(input.escapes.length, reply.verdict.ratings)
      if (missing.length > 0 || duplicated.length > 0) {
        return yield* Effect.fail(new SeverityRatingsIncomplete({ missing, duplicated, sessions: reply.sessions }))
      }
      const byIndex = new Map(reply.verdict.ratings.map((rating) => [rating.index, rating.category]))
      const rated = input.escapes.map((escape, index) => {
        const category = byIndex.get(index)!
        return { ...escape, category, severity: severityOf(category) }
      })
      return { rated, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
