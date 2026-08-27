import { Effect, FileSystem, Schema } from "effect"
import { DerivationEmpty, DerivationRunRootMissing, DerivedCopyFailed } from "mag/graph-nodes/derive-vision/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo } from "mag/runtime/run-info"
import { compileDeriveVision } from "mag/skills/envision/derivation"

/** Where the session writes its drawing, inside its own working directory. `codeRoot` is an OS
 * temp directory, never nested under the run root; `stage-shipped-graph/stage.ts` mints it and
 * holds the reasoning for why. */
export const DRAWING_FILENAME = "derived-vision.md"

/** What the session must return: the path it wrote, echoed and then ignored in favour of this
 * node's own computed path, matching `envision-mermaid/graph-node.ts`'s own precedent. */
const VERDICT = verdictSchema(Schema.Struct({ derivedVisionPath: Schema.String }))

/**
 * Dispatches a session into `codeRoot`, the staged copy `stage-shipped-graph` already stripped of
 * every vision, and asks it to draw the railway `graphRoot`'s code alone walks. Blindness holds
 * structurally, not by instruction: nothing at `codeRoot` names the shipped vision, so there is
 * nothing there for the session to read even if it tried.
 *
 * `name` is absent from this node's own input: no line in this node's own behavior needs it,
 * `compileDeriveVision` names `graphRoot` and `destination` alone, and a field nothing reads is not
 * this node's to carry.
 */
export const deriveVision = make({
  name: "derive-vision",
  description: "Draw the vision the staged, vision-blind code actually walks.",
  input: Schema.Struct({ codeRoot: Schema.String, graphRoot: Schema.String }),
  success: Schema.Struct({
    derivedVisionPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new DerivationRunRootMissing())
      const destination = `${input.codeRoot}/${DRAWING_FILENAME}`

      const fs = yield* FileSystem.FileSystem
      const agent = yield* ClaudeAgent
      const reply = yield* agent.prompt({
        prompt: compileDeriveVision({ graphRoot: input.graphRoot, destination }),
        jsonSchema: VERDICT,
        cwd: input.codeRoot
      })

      const written = yield* fs.readFileString(destination).pipe(Effect.catch(() => Effect.succeed("")))
      if (written.trim() === "") {
        return yield* Effect.fail(new DerivationEmpty({ destination, sessions: reply.sessions }))
      }

      // The run's own record holds the drawing independent of the staging tree: `code-only` is
      // discardable evidence, the run root is not.
      const derivedVisionPath = yield* writeArtifact(fs, runInfo.runRoot, "derived-vision", written).pipe(
        Effect.catch((error) =>
          Effect.fail(
            new DerivedCopyFailed({ runRoot: runInfo.runRoot, detail: String(error), sessions: reply.sessions })
          )
        )
      )

      return { derivedVisionPath, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
