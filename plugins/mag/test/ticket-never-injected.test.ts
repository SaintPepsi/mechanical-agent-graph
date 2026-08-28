import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
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
import { inputExamples as reviewInputs } from "mag/graph-nodes/review-diff/examples"
import { reviewDiff } from "mag/graph-nodes/review-diff/graph-node"
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
  { node: brainstorm, input: brainstormInputs[0]!, shell: () => scriptedShell([]).service },
  { node: design, input: designInputs[0]!, shell: () => scriptedShell([]).service },
  { node: envisionNotation, input: notationInputs[0]!, shell: () => scriptedShell([]).service },
  { node: build, input: buildInputs[0]!, shell: buildShell },
  { node: reviewDiff, input: reviewInputs[0]!, shell: () => reviewShell(reviewInputs[0]!.headSha) }
]

/** Registered nodes that carry `ticketPath` without composing a prompt of their own: composites handing it to a node in NODES, and the mechanical readers (`github-ticket-create`'s is ticket-writer's JSON draft, read into a `gh` call). */
const NON_DISPATCHING: ReadonlyArray<string> = ["envision-visions", "build-under-review", "design-graph", "require-acs", "github-ticket-create"]

/** Every command node in the registry, groups walked. */
const commandNodes = (entries: Registry): ReadonlyArray<GraphNode<any, any, any, any>> =>
  entries.flatMap((entry) =>
    entry.kind === "command" ? [entry.node] : entry.kind === "group" ? commandNodes(entry.children) : []
  )

/** The input schema's own field names, read off its AST the way `schema-flags.ts` walks it. */
const inputFields = (node: GraphNode<any, any, any, any>): ReadonlyArray<PropertyKey> => {
  const ast = node.input.ast
  return ast._tag === "Objects" ? ast.propertySignatures.map((signature) => signature.name) : []
}

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
    const covered = new Set([...NODES.map(({ node }) => node.name), ...NON_DISPATCHING])
    const carriers = commandNodes(registry).filter((node) => inputFields(node).includes("ticketPath")).map((node) => node.name)
    expect(carriers.length).toBeGreaterThan(0)
    for (const name of carriers) expect(covered).toContain(name)
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
