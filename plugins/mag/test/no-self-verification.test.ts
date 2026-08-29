import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { inputExamples as buildInputs } from "mag/graph-nodes/build/examples"
import { build } from "mag/graph-nodes/build/graph-node"
import { inputExamples as shellInputs } from "mag/graph-nodes/envision-shell/examples"
import { envisionShell } from "mag/graph-nodes/envision-shell/graph-node"
import { inputExamples as simplifyInputs } from "mag/graph-nodes/simplify/examples"
import { simplify } from "mag/graph-nodes/simplify/graph-node"
import { type ClaudeAgentService, claudeAgentLayer } from "mag/runtime/claude/service"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { recordingAgent, scriptedShell, testRunInfo } from "mag/test/node-fixture"

/**
 * No compiled prompt, and no agent definition, may instruct a session to run the
 * repository's declared verification suite: a session with nothing to verify (`envision-shell`,
 * dispatched under `--agent effect-expert` by `develop-graph`) has no way to tell the difference
 * between "the repo's suite happens to be red" and "I broke it," so it must never be asked to check.
 * Neither `build` nor `simplify` carries a `command` field; the regex below is what catches a
 * wording regression if either ever grows one, or if a fourth carrier splices the same sentence in
 * some other way.
 */
const NAMES_THE_SUITE = /verification suite|bun run (typecheck|test)|red suite/i

/** Resolved from this file's location, `skills/installed.ts`'s `SKILLS_ROOT` idiom, never `process.cwd()`. */
const AGENTS_DIR = join(import.meta.dirname, "..", "..", "..", ".claude", "agents")

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

/**
 * Dispatches one node far enough to record its prompt. Every failure is swallowed: a stub that
 * answers one canned reply cannot satisfy what a node does after its dispatch (`envision-shell`
 * fails `ShellMissing` on the design file the stub never writes), and the prompt is already
 * recorded by then.
 */
const dispatch = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, shell: ShellService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, testRunInfo())
      )
    )
  )

describe("no self-verification", () => {
  // Every row in build/examples.ts, not a hand-picked subset: row 1 carries a design addendum, row 3
  // a resumed repair's own addendum, the one carrier that once said "verification suite"
  // itself (`addenda.ts`'s `verificationAddendum`) before it was reworded, so this loop is
  // what would have caught that regression instead of the two clean rows either side of it.
  test("build's prompt names no suite command, across every example row", async () => {
    const agent = recordingAgent()
    for (const input of buildInputs) {
      const shell = scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service
      await dispatch(build.run(input), agent.service, shell)
    }

    expect(agent.prompts).toHaveLength(buildInputs.length)
    for (const prompt of agent.prompts) expect(prompt).not.toMatch(NAMES_THE_SUITE)
  })

  test("simplify's prompt names no suite command", async () => {
    const agent = recordingAgent()
    const input = simplifyInputs[0]!
    const shell = scriptedShell([out(`${input.headSha}\n`), out("x.ts\n"), out(""), out(""), out(`${input.headSha}\n`)]).service
    await dispatch(simplify.run(input), agent.service, shell)

    expect(agent.prompts).toHaveLength(1)
    expect(agent.prompts[0]!).not.toMatch(NAMES_THE_SUITE)
  })

  // `envision-shell` never named a suite of its own; the instruction only ever
  // reached it through `--agent effect-expert` (`graphs/develop-graph/graph.ts`'s `EFFECT_AGENT`), so its own compiled
  // prompt is asserted here mechanically rather than trusted by inspection.
  test("envision-shell's prompt names no suite command", async () => {
    const agent = recordingAgent()
    await dispatch(envisionShell.run(shellInputs[0]!), agent.service, scriptedShell([]).service)

    expect(agent.prompts).toHaveLength(1)
    expect(agent.prompts[0]!).not.toMatch(NAMES_THE_SUITE)
  })

  test("no .claude/agents/*.md instructs a session to verify the suite", () => {
    const files = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(join(AGENTS_DIR, file), "utf8")
      expect(text).not.toMatch(NAMES_THE_SUITE)
    }
  })
})
