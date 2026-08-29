import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema, SchemaAST } from "effect"
import { ShellBlocked, ShellMissing, ShellRunRootMissing, UnknownNotation } from "mag/graph-nodes/envision-shell/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/envision-shell/examples"
import { envisionShell } from "mag/graph-nodes/envision-shell/graph-node"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellService, shellLayer } from "mag/runtime/shell"
import { envisionEffect } from "mag/skills/design/envision-effect"
import { envisionGeneric } from "mag/skills/design/envision-generic"
import { envisionSvelte } from "mag/skills/design/envision-svelte"
import { NOTATIONS } from "mag/skills/design/envisioning"
import { BLIND_DRAW_RULE, SHELL_SECTION } from "mag/skills/envision/notation"
import { scriptedShell, stubAgent as recordAgent, withForeignRepo, withRecordRepo } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!

/** The verdict echoes a path the node never trusts; the success carries the path the node computed. */
const stubAgent = (reply: Partial<ClaudeReply<unknown>> = {}, write?: () => void) =>
  recordAgent({ designPath: "ignored, the node uses its own computed path" }, { costUsd: 0.12, ...reply }, write)

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, shell: ShellService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

const withRepo = <T>(fn: (repoRoot: string, runRoot: string, run: RunInfoService) => Promise<T>) => withRecordRepo("envision-shell", fn)

const designIn = (repoRoot: string): string => join(repoRoot, "docs", "graph", INPUT.ticket, "design.md")

const writeShell = (repoRoot: string, content = `# Design\n\n${SHELL_SECTION}\n\ngraph TD\n  A --> B\n`): string => {
  const path = designIn(repoRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

describe("envision-shell", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(envisionShell.input)) throw new Error("envisionShell.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(envisionShell.input)(example)
    if (!isSchemaHandle(envisionShell.success)) throw new Error("envisionShell.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(envisionShell.success)(example)
  })

  test("one session carries the ticket, the blind-draw rule once, every matched notation's body, and the design doc as its one destination; no git call", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeShell(repoRoot))
      const { calls, service: shell } = scriptedShell([])
      const result = await runWith(envisionShell.run(INPUT), agent.service, shell, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        designPath: designIn(repoRoot),
        modules: [envisionSvelte.id, envisionEffect.id],
        sessionRef: "stub-session",
        sessions: ["stub-session"],
        costUsd: 0.12
      })
      expect(calls).toHaveLength(0)

      expect(agent.requests).toHaveLength(1)
      const request = agent.requests[0]!
      expect(request.cwd).toBe(repoRoot)
      expect(request.resume).toBeUndefined()
      expect(request.prompt).toContain(`Read the ticket at \`${INPUT.ticketPath}\`.`)
      expect(request.prompt.split(BLIND_DRAW_RULE).length - 1).toBe(1)
      expect(request.prompt).toContain(envisionSvelte.section!.body(null))
      expect(request.prompt).toContain(envisionEffect.section!.body(null))
      expect(request.prompt).not.toContain(envisionGeneric.section!.body(null))
      expect(request.prompt).toContain(`Write the design doc to \`${designIn(repoRoot)}\``)
      expect(request.prompt).toContain(SHELL_SECTION)
    }))

  // Blindness is a property of the schema: the only path field is the ticket's, so no caller can
  // hand this pass a discover note, and the prompt can only ever be composed from the ticket
  // reference and the compiled notation bodies.
  test("the input schema names no path but the ticket's", () => {
    const ast = envisionShell.input.ast
    if (!SchemaAST.isObjects(ast)) throw new Error("envisionShell.input is not a struct")
    const paths = ast.propertySignatures.map((signature) => String(signature.name)).filter((name) => name.endsWith("Path"))
    expect(paths).toStrictEqual(["ticketPath"])
  })

  test("no matched notation draws the generic one, and agent/model reach the dispatch", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const agent = stubAgent({}, () => writeShell(repoRoot))
      const result = await runWith(envisionShell.run(inputExamples[1]!), agent.service, scriptedShell([]).service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.modules).toStrictEqual([envisionGeneric.id])
      expect(agent.requests[0]!.agent).toBe("effect-expert")
      expect(agent.requests[0]!.model).toBe("opus")
    }))

  test("an unknown notation fails UnknownNotation, naming the known set, before any dispatch", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const agent = stubAgent()
      const result = await runWith(envisionShell.run({ ...INPUT, notations: ["cobol"] }), agent.service, scriptedShell([]).service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(UnknownNotation)
      expect((result.failure as UnknownNotation).known).toStrictEqual(NOTATIONS)
      expect(agent.requests).toHaveLength(0)
    }))

  test("a declared block is trusted: the reason lands as vision-blocked-1.md, the failure carries its path, and the design is never read", () =>
    withRepo(async (repoRoot, runRoot, run) => {
      const agent = stubAgent({ verdict: { designPath: "ignored", blocked: "the ticket names no shape to draw" } }, () => writeShell(repoRoot))
      const result = await runWith(envisionShell.run(INPUT), agent.service, scriptedShell([]).service, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ShellBlocked)
      expect((result.failure as ShellBlocked).reasonPath).toBe(`${runRoot}/vision-blocked-1.md`)
      expect((result.failure as ShellBlocked).sessions).toStrictEqual(["stub-session"])
      expect(readFileSync(`${runRoot}/vision-blocked-1.md`, "utf8")).toBe("the ticket names no shape to draw")
    }))

  test("a missing, blank, or unchanged design is ShellMissing", () =>
    withRepo(async (repoRoot, _runRoot, run) => {
      const missing = await runWith(envisionShell.run(INPUT), stubAgent().service, scriptedShell([]).service, run)
      expect(Result.isFailure(missing) && missing.failure instanceof ShellMissing).toBe(true)
      expect(existsSync(designIn(repoRoot))).toBe(false)

      const blank = await runWith(envisionShell.run(INPUT), stubAgent({}, () => writeShell(repoRoot, "  \n")).service, scriptedShell([]).service, run)
      expect(Result.isFailure(blank) && blank.failure instanceof ShellMissing).toBe(true)

      writeShell(repoRoot)
      const stale = await runWith(envisionShell.run(INPUT), stubAgent().service, scriptedShell([]).service, run)
      expect(Result.isFailure(stale) && stale.failure instanceof ShellMissing).toBe(true)
      expect((stale as Result.Failure<never, ShellMissing>).failure.path).toBe(designIn(repoRoot))
    }))

  test("an empty run root fails ShellRunRootMissing before any dispatch", () =>
    withRepo(async (_repoRoot, _runRoot, run) => {
      const agent = stubAgent()
      const result = await runWith(envisionShell.run(INPUT), agent.service, scriptedShell([]).service, { ...run, runRoot: "" })
      expect(Result.isFailure(result) && result.failure instanceof ShellRunRootMissing).toBe(true)
      expect(agent.requests).toHaveLength(0)
    }))

  // A foreign run under the default policy: the design composes under `recordsRoot`, the session
  // dispatches at `workRoot`, and nothing is copied or committed here (`brainstorm` records once).
  test("a foreign run writes the shell under recordsRoot and dispatches at workRoot, copying nothing yet", () =>
    withForeignRepo("envision-shell", async (workRoot, recordsRoot, run) => {
      const path = join(recordsRoot, "docs", "graph", INPUT.ticket, "design.md")
      const agent = stubAgent({}, () => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, `${SHELL_SECTION}\n\nshell\n`)
      })
      const result = await runWith(envisionShell.run(INPUT), agent.service, scriptedShell([]).service, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.designPath).toBe(path)
      expect(agent.requests[0]!.cwd).toBe(workRoot)
      expect(existsSync(`${run.runRoot}/design.md`)).toBe(false)
    }))
})
