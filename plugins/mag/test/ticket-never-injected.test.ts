import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { inputExamples as brainstormInputs } from "mag/graph-nodes/brainstorm/examples"
import { brainstorm } from "mag/graph-nodes/brainstorm/graph-node"
import { inputExamples as buildInputs } from "mag/graph-nodes/build/examples"
import { build } from "mag/graph-nodes/build/graph-node"
import { inputExamples as designInputs } from "mag/graph-nodes/design/examples"
import { design } from "mag/graph-nodes/design/graph-node"
import { inputExamples as discoverInputs } from "mag/graph-nodes/discover/examples"
import { discover } from "mag/graph-nodes/discover/graph-node"
import { inputExamples as notationInputs } from "mag/graph-nodes/envision-notation/examples"
import { envisionNotation } from "mag/graph-nodes/envision-notation/graph-node"
import { githubTicketCreate } from "mag/graph-nodes/github-ticket-create/graph-node"
import { inputExamples as planInputs } from "mag/graph-nodes/plan/examples"
import { plan } from "mag/graph-nodes/plan/graph-node"
import { inputExamples as recycleInputs } from "mag/graph-nodes/recycle-map/examples"
import { recycleMap } from "mag/graph-nodes/recycle-map/graph-node"
import { requireAcs } from "mag/graph-nodes/require-acs/graph-node"
import { inputExamples as reviewInputs } from "mag/graph-nodes/review-diff/examples"
import { reviewDiff } from "mag/graph-nodes/review-diff/graph-node"
import { inputExamples as reviewPlanInputs } from "mag/graph-nodes/review-plan/examples"
import { reviewPlan } from "mag/graph-nodes/review-plan/graph-node"
import { registry } from "mag/registry"
import { type ClaudeAgentService, claudeAgentLayer } from "mag/runtime/claude/service"
import type { GraphNode } from "mag/runtime/graph-node.definition"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import type { Registry } from "mag/runtime/types"
import { recordingAgent, scriptedShell, testRunInfo, withRunRoot } from "mag/test/node-fixture"

/**
 * No agent node's prompt may carry the ticket's text: the ticket is an immutable artifact in the
 * run root and a prompt cites it by path. Every node below is dispatched over a ticket file
 * holding this sentinel, from its own first example row with `ticketPath` pointed at that file;
 * a prompt that contains the sentinel has spliced the file in, and a prompt that omits the
 * citation has lost the reference.
 */
const SENTINEL = "SENTINEL-ticket-body-must-never-reach-a-prompt"

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

/** One clean committing pass, `no-self-verification.test.ts`'s own build script. */
const buildShell = () => scriptedShell([out("aaa111\n"), out(""), out(""), out("1\n"), out("bbb222\n")]).service

/** Head gate, the diff, the touched paths, the declared principles files: `review-diff`'s four reads, in order. */
const reviewShell = (headSha: string) => scriptedShell([out(`${headSha}\n`), out(""), out(""), out("")]).service

/** Ticket-driven agent nodes, each with the shell its dispatch needs to reach the prompt. A node whose dispatch spine ends in a file check fails after the prompt is already recorded, which is all this test reads. */
const NODES: ReadonlyArray<{
  readonly node: GraphNode<any, any, any, never>
  readonly input: { readonly ticketPath: string; readonly [key: string]: unknown }
  readonly shell: () => ShellService
}> = [
  { node: discover, input: discoverInputs[0]!, shell: () => scriptedShell([]).service },
  { node: recycleMap, input: recycleInputs[0]!, shell: () => scriptedShell([]).service },
  // The rulings `ls-files` read, empty: a first brainstorm pass's one git call before its dispatch.
  { node: brainstorm, input: brainstormInputs[0]!, shell: () => scriptedShell([out("")]).service },
  { node: plan, input: planInputs[0]!, shell: () => scriptedShell([]).service },
  // The rulings `ls-files` read, empty: `review-plan`'s one git call before its dispatch.
  { node: reviewPlan, input: reviewPlanInputs[0]!, shell: () => scriptedShell([out("")]).service },
  { node: design, input: designInputs[0]!, shell: () => scriptedShell([]).service },
  { node: envisionNotation, input: notationInputs[0]!, shell: () => scriptedShell([]).service },
  { node: build, input: buildInputs[0]!, shell: buildShell },
  { node: reviewDiff, input: reviewInputs[0]!, shell: () => reviewShell(reviewInputs[0]!.headSha) }
]

/**
 * Registered nodes that carry `ticketPath` without composing a prompt of their own: composites
 * handing it to a node in NODES, and the mechanical readers (`github-ticket-create`'s is
 * ticket-writer's JSON draft, read into a `gh` call). Not a bare allowlist: the test below proves
 * each one's own module never reaches `ClaudeAgent`, so a listed node cannot start dispatching
 * without leaving this list.
 */
const NON_DISPATCHING: ReadonlyArray<{ readonly name: string; readonly source: string }> = [
  { name: "envision-visions", source: "graph-nodes/envision-visions/graph-node.ts" },
  { name: "build-under-review", source: "graph-nodes/build-under-review/graph-node.ts" },
  { name: "design-under-review", source: "graph-nodes/design-under-review/graph-node.ts" },
  { name: "design-graph", source: "graphs/design-graph/graph.ts" },
  { name: "require-acs", source: "graph-nodes/require-acs/graph-node.ts" },
  { name: "github-ticket-create", source: "graph-nodes/github-ticket-create/graph-node.ts" }
]

/** Resolved from this file's location, `skills/installed.ts`'s `SKILLS_ROOT` idiom, never `process.cwd()`. */
const SRC = join(import.meta.dirname, "..", "src")

/** Every command node in the registry, groups walked. */
const commandNodes = (entries: Registry): ReadonlyArray<GraphNode<any, any, any, any>> =>
  entries.flatMap((entry) =>
    entry.kind === "command" ? [entry.node] : entry.kind === "group" ? commandNodes(entry.children) : []
  )

/** A schema's own field names, read off its AST the way `schema-flags.ts` walks it. */
const fieldsOf = (schema: { readonly ast: { readonly _tag: string; readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey }> } }): ReadonlyArray<PropertyKey> =>
  schema.ast._tag === "Objects" ? (schema.ast.propertySignatures ?? []).map((signature) => signature.name) : []

/**
 * Field names under which model prose has ridden a success value before, and may not again: each
 * is a run-root file now (`build-N.md`, `dispute-N.md`, `pr-description-N.md`, `vision-blocked-N.md`)
 * or was dropped because the commit is the artifact. A success carries the file's path, never the text.
 */
const MODEL_PROSE_FIELDS: ReadonlyArray<PropertyKey> = ["description", "summary", "note", "dispute", "reason", "blocking", "body"]

const dispatch = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, shell: ShellService, runRoot: string) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(shellLayer(shell), claudeAgentLayer(agent))),
        Effect.provideService(RunInfo, testRunInfo({ runRoot }))
      )
    )
  )

describe("the ticket is never injected", () => {
  test("every registered node whose input carries ticketPath is dispatched here, or is named as non-dispatching", () => {
    const covered = new Set([...NODES.map(({ node }) => node.name), ...NON_DISPATCHING.map(({ name }) => name)])
    const carriers = commandNodes(registry).filter((node) => fieldsOf(node.input).includes("ticketPath")).map((node) => node.name)
    expect(carriers.length).toBeGreaterThan(0)
    for (const name of carriers) expect(covered).toContain(name)
  })

  for (const { name, source } of NON_DISPATCHING) {
    test(`${name} composes no prompt of its own: its module never reaches ClaudeAgent`, () => {
      const text = readFileSync(join(SRC, source), "utf8")
      expect(text).not.toContain("ClaudeAgent")
      expect(text).not.toContain("mag/runtime/claude/service")
    })
  }

  // The two mechanical readers, dispatched for real with an agent that fails on any call: a
  // ticket file that carries the sentinel reaches no session because no session is ever opened.
  test("require-acs reads the ticket file and opens no session", () =>
    withRunRoot("ticket-never-injected", async (runRoot) => {
      const ticketPath = join(runRoot, "ticket.md")
      writeFileSync(ticketPath, `# Title\n\n${SENTINEL}\n\n## Acceptance Criteria\n\n- one\n`)
      const agent = recordingAgent()
      const result = await dispatch(requireAcs.run({ ticket: "GH-98", title: "Title", ticketPath }), agent.service, scriptedShell([]).service, runRoot)
      expect(Result.isSuccess(result)).toBe(true)
      expect(agent.prompts).toHaveLength(0)
    }))

  test("github-ticket-create reads the draft and opens no session", () =>
    withRunRoot("ticket-never-injected", async (runRoot) => {
      const agent = recordingAgent()
      await dispatch(githubTicketCreate.run({ ticketPath: join(runRoot, "absent.json") }), agent.service, scriptedShell([]).service, runRoot)
      expect(agent.prompts).toHaveLength(0)
    }))

  test("no registered node's success schema carries model prose by value under a name it once did", () => {
    const offenders = commandNodes(registry).flatMap((node) =>
      fieldsOf(node.success).filter((field) => MODEL_PROSE_FIELDS.includes(field)).map((field) => `${node.name}.${String(field)}`)
    )
    expect(offenders).toStrictEqual([])
  })

  for (const { node, input, shell } of NODES) {
    test(`${node.name}'s prompt cites the ticket file and carries none of its text`, () =>
      withRunRoot("ticket-never-injected", async (runRoot) => {
        const ticketPath = join(runRoot, "ticket.md")
        writeFileSync(ticketPath, `# Title\n\n${SENTINEL}\n`)
        const agent = recordingAgent()
        await dispatch(node.run({ ...input, ticketPath }), agent.service, shell(), runRoot)

        expect(agent.prompts).toHaveLength(1)
        expect(agent.prompts[0]!).toContain(`Read the ticket at \`${ticketPath}\`.`)
        expect(agent.prompts[0]!).not.toContain(SENTINEL)
      }))
  }
})
