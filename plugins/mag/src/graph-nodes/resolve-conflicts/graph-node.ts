import { Effect, Schema } from "effect"
import { detectConflicts } from "mag/graph-nodes/detect-conflicts/graph-node"
import { commitMerge, fixConflicts } from "mag/graph-nodes/fix-conflicts/graph-node"
import { verification } from "mag/graph-nodes/verification/graph-node"
import { make } from "mag/runtime/graph-node.definition"
import { RunInfo, workdir } from "mag/runtime/run-info"

/** Detect, and only on conflict fix, verify the staged tree, and commit. Mints no tagged error of its own: every failure is one `detect-conflicts`, `fix-conflicts` or `verification` already raises. */
export const resolveConflicts = make({
  name: "resolve-conflicts",
  description: "Detect a merge conflict between base and target, and only on conflict, fix, verify and commit it.",
  input: Schema.Struct({
    base: Schema.String,
    target: Schema.String,
    command: Schema.String,
    /** A named agent for the resolver dispatch, forwarded to `fix-conflicts` verbatim. */
    agent: Schema.optional(Schema.String),
    /** `--model` for the resolver dispatch — same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    base: Schema.String,
    target: Schema.String,
    conflicts: Schema.Array(Schema.String),
    resolved: Schema.Boolean,
    headSha: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const detected = yield* detectConflicts.run({ base: input.base, target: input.target })

      if (detected.conflicts.length === 0) {
        return {
          base: input.base,
          target: input.target,
          conflicts: detected.conflicts,
          resolved: false,
          headSha: detected.targetSha,
          sessions: [],
          costUsd: 0
        }
      }

      const fixed = yield* fixConflicts.run({
        base: input.base,
        target: input.target,
        baseSha: detected.baseSha,
        targetSha: detected.targetSha,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })
      yield* verification.run({ command: input.command, headSha: fixed.treeSha })

      const runInfo = yield* RunInfo
      const committed = yield* commitMerge(workdir(runInfo), input.base, input.target, fixed.sessions)

      return {
        base: input.base,
        target: input.target,
        conflicts: detected.conflicts,
        resolved: true,
        headSha: committed.headSha,
        sessions: fixed.sessions,
        costUsd: fixed.costUsd
      }
    })
})
