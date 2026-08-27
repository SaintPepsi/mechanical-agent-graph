import { Effect, FileSystem, Schema } from "effect"
import {
  EnvisionRailSketchCommitFailed,
  EnvisionRailSketchGitFailed,
  EnvisionRailSketchRunRootMissing,
  RailSketchMissing
} from "mag/graph-nodes/envision-rail-sketch/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { commitPath } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { requireRunRoot } from "mag/runtime/records"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { compileEnvisionRailSketch } from "mag/skills/envision/rail-sketch"

/** The one artifact this node writes — `envision-mermaid`'s `VISION_FILENAME` convention, mirrored. */
export const RAIL_SKETCH_FILENAME = "rail-sketch.md"

/** What the session must return: the sketch path it wrote, echoed and then ignored in favour of this node's own computed path. */
const SKETCH = verdictSchema(Schema.Struct({ sketchPath: Schema.String }))

const messageFor = (name: string, sessions: readonly string[]): string =>
  [`${name}: rail-sketch committed by envision-rail-sketch`, "", ...sessions.map((session) => `Claude-Session: ${session}`)]
    .join("\n")

/**
 * The effect-expert dispatch. The vision travels as a path, never as prompt text (an artifact
 * travels as a reference, and an oversized prompt dies at `execve`) — the session reads
 * `input.visionPath` itself. Same unconditional-commit spine as `envision-mermaid`, over its own
 * `rail-sketch.md`, including the before/after snapshot compare and the `requireRunRoot` precheck.
 */
export const envisionRailSketch = make({
  name: "envision-rail-sketch",
  description: "Give every node in the vision a typed shape, its when-conditions and its error channel, then commit the rail-sketch.",
  input: Schema.Struct({
    folder: Schema.String,
    visionPath: Schema.String,
    name: Schema.String,
    /** A named agent to run the session as, `design`'s own convention. */
    agent: Schema.optional(Schema.String),
    /** `--model`, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    sketchPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      yield* requireRunRoot(() => new EnvisionRailSketchRunRootMissing())

      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      const sketchPath = `${input.folder}/${RAIL_SKETCH_FILENAME}`

      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(sketchPath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: compileEnvisionRailSketch({ name: input.name, visionPath: input.visionPath, destination: sketchPath }),
        jsonSchema: SKETCH,
        cwd,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model })
      })

      const written = yield* fs.readFileString(sketchPath).pipe(Effect.catch(() => Effect.succeed("")))
      if (written.trim() === "" || written === before) {
        return yield* Effect.fail(new RailSketchMissing({ path: sketchPath, sessions: reply.sessions }))
      }

      yield* commitPath(
        cwd,
        sketchPath,
        messageFor(input.name, reply.sessions),
        reply.sessions,
        (fields) => new EnvisionRailSketchGitFailed(fields),
        (fields) => new EnvisionRailSketchCommitFailed(fields)
      )

      return { sketchPath, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
