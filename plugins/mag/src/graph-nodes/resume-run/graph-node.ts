import { Effect, Option, Schema } from "effect"
import { make } from "mag/runtime/graph-node.definition"
import { selectPredecessor } from "mag/runtime/resume"
import { resolveRepoRoot, RunRootEnv } from "mag/runtime/run-layers"
import { ticketDirFor } from "mag/runtime/run-root"

/**
 * Answers "what would a resume pick" without walking a graph: `bun run mag resume-run --ticket X
 * --graph Y` calls the same `selectPredecessor` `runScopedLayers` calls, so the operator sees the
 * id a real resume would adopt before spending a token on it.
 *
 * Resolves `repoRoot` itself rather than reading `RunInfo`: this node is meant to run standalone from
 * the CLI, before any run exists, the way `gather-reviews` reads `RunRootEnv` directly rather than a
 * run-scoped service.
 */
export const resumeRun = make({
  name: "resume-run",
  description: "Show which prior run of a ticket a resume would continue from, without spending a run.",
  input: Schema.Struct({
    ticket: Schema.String,
    graph: Schema.String
  }),
  success: Schema.Struct({
    predecessorRunId: Schema.String,
    journalPath: Schema.String,
    /** Present only when the chosen predecessor was itself a resume — `ResumeSelection.workRoot`, unadopted. */
    workRoot: Schema.optional(Schema.String),
    rule: Schema.String,
    replayable: Schema.Int
  }),
  run: (input) =>
    Effect.gen(function* () {
      const root = yield* RunRootEnv
      const repoRoot = yield* resolveRepoRoot
      const ticketDir = ticketDirFor({ ...root, repoPath: repoRoot, ticket: input.ticket })
      const selection = yield* selectPredecessor({ ticketDir, graph: input.graph })

      return {
        predecessorRunId: selection.predecessorRunId,
        journalPath: selection.journalPath,
        // Omitted, not `undefined`-valued: `row.ts`'s own idiom for an optional field (`startRow`'s
        // `input` spread) — the key is either there or it isn't, never present carrying `undefined`.
        ...(Option.isSome(selection.workRoot) ? { workRoot: selection.workRoot.value } : {}),
        rule: selection.rule,
        replayable: selection.replayable
      }
    })
})
