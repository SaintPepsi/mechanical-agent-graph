import { Effect, FileSystem, Schema } from "effect"
import {
  EnvisionMermaidCommitFailed,
  EnvisionMermaidGitFailed,
  EnvisionMermaidRunRootMissing,
  VisionMissing
} from "mag/graph-nodes/envision-mermaid/errors"
import { ClaudeAgent } from "mag/runtime/claude/service"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { commitPath } from "mag/runtime/git"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { requireRunRoot } from "mag/runtime/records"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { compileEnvisionMermaid } from "mag/skills/envision/mermaid"

/** The one artifact this node writes. Legal as a second export because the node-export conformance rule counts object exports only. */
export const VISION_FILENAME = "vision.md"

/** What the session must return: the vision path it wrote, echoed and then ignored in favour of
 * this node's own computed path (`design`'s own precedent). */
const VISION = verdictSchema(Schema.Struct({ visionPath: Schema.String }))

const messageFor = (name: string, sessions: readonly string[]): string =>
  [`${name}: vision committed by envision-mermaid`, "", ...sessions.map((session) => `Claude-Session: ${session}`)].join("\n")

/**
 * The basic-tier dispatch — no `agent`, no `model` passed, which is what "basic tier" means (the
 * session default). Draws the mermaid vision at full granularity, then commits it unconditionally:
 * `vision.md` is this graph's own deliverable (`envision/graph.ts` writes it into
 * `plugins/mag/src/graphs/<name>/`, not a policy-gated record), so there is nothing here for
 * `records.ts`'s `record` to gate. `runRoot` is still checked before dispatch (`requireRunRoot`), a
 * bare CLI run outside `runScopedLayers` is a wiring bug that must not pay for a session first — the
 * same precheck `design`/`discover`/`brainstorm`/`envision-notation` already run, kept here even
 * though this node copies nothing into it, since it is still the "was this run ever scoped" signal.
 *
 * Never trusts the session's own claim: the written document must be present, non-empty after trim,
 * and changed from a snapshot taken before dispatch — a re-run overwrites in place, so a stale
 * `vision.md` from a prior pass would otherwise pass a no-op session. Committed pathspec-scoped to
 * this one path (`commitPath`, `git.ts`), so a session that strays and writes its sibling artifact
 * leaves an uncommitted stray, not a committed one.
 */
export const envisionMermaid = make({
  name: "envision-mermaid",
  description: "Draw the ideal graph in mermaid at full granularity, then commit the vision.",
  input: Schema.Struct({ folder: Schema.String, name: Schema.String }),
  success: Schema.Struct({
    visionPath: Schema.String,
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      yield* requireRunRoot(() => new EnvisionMermaidRunRootMissing())

      const agent = yield* ClaudeAgent
      const runInfo = yield* RunInfo
      const cwd = workdir(runInfo)
      // String concatenation, `recordPath`'s idiom (`run-info.ts`): `folder` already carries forward slashes.
      const visionPath = `${input.folder}/${VISION_FILENAME}`

      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(visionPath).pipe(Effect.catch(() => Effect.succeed("")))

      const reply = yield* agent.prompt({
        prompt: compileEnvisionMermaid({ name: input.name, destination: visionPath }),
        jsonSchema: VISION,
        cwd
      })

      const written = yield* fs.readFileString(visionPath).pipe(Effect.catch(() => Effect.succeed("")))
      if (written.trim() === "" || written === before) {
        return yield* Effect.fail(new VisionMissing({ path: visionPath, sessions: reply.sessions }))
      }

      yield* commitPath(
        cwd,
        visionPath,
        messageFor(input.name, reply.sessions),
        reply.sessions,
        (fields) => new EnvisionMermaidGitFailed(fields),
        (fields) => new EnvisionMermaidCommitFailed(fields)
      )

      return { visionPath, sessions: reply.sessions, costUsd: reply.costUsd }
    }).pipe(Effect.provide(platform))
})
