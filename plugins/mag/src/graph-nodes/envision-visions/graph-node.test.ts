import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { NotationVisionBlocked, NotationVisionMissing } from "mag/graph-nodes/envision-visions/errors"
import { envisionVisions } from "mag/graph-nodes/envision-visions/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/envision-visions/examples"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

const INPUT = { ticket: "GH-288", title: "Envision and build the design graph", ticketPath: "/run/ticket.md" }

/** `git diff --cached --quiet` is the only argv this stub inspects; every other call it lets
 * through — order-independent, unlike `envision-notation`'s own `scriptedShell`, because the two
 * routes' git calls interleave under `concurrency: "unbounded"` and a fixed reply queue cannot tell
 * them apart. */
const alwaysCommits: ShellService = {
  run: (argv) => Effect.succeed({ exitCode: argv[1] === "diff" ? 1 : 0, stdout: "", stderr: "" })
}

/** Extracts the destination `compileEnvisionNotation` spliced into the prompt — the one thing every
 * route's request differs by, so a stub agent can tell routes apart without a second channel. */
const destinationOf = (prompt: string): string => {
  const match = prompt.match(/Write the vision to `([^`]+)`\./)
  if (match === null || match[1] === undefined) throw new Error(`no destination in prompt: ${prompt}`)
  return match[1]
}

/**
 * A per-route scriptable agent: `behavior(destination, callNumber)` decides whether this call
 * writes the vision and what the verdict says, so a test can make one route miss its first write
 * and land its retry, while its sibling succeeds first try.
 */
const stubAgent = (behavior: (destination: string, callNumber: number) => { readonly write: boolean; readonly blocked?: string }) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const calls: Record<string, number> = {}
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      const destination = destinationOf(request.prompt)
      calls[destination] = (calls[destination] ?? 0) + 1
      const decision = behavior(destination, calls[destination])
      if (decision.write) {
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, `graph TD\n  A --> B\n  attempt ${calls[destination]}\n`)
      }
      const verdict = decision.blocked === undefined ? { visionPath: destination } : { visionPath: destination, blocked: decision.blocked }
      return Effect.succeed({
        verdict: verdict as A,
        result: {},
        sessions: [`session-${destination}-${calls[destination]}`],
        costUsd: 0.1,
        attempts: 1
      } as ClaudeReply<A>)
    }
  }
  return { requests, calls, service }
}

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, agent: ClaudeAgentService, shell: ShellService, run: RunInfoService) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(Layer.mergeAll(claudeAgentLayer(agent), shellLayer(shell))),
        Effect.provideService(RunInfo, run)
      )
    )
  )

const withRepo = async <T>(fn: (repoRoot: string, run: RunInfoService) => Promise<T>): Promise<T> => {
  const repoRoot = mkdtempSync(join(tmpdir(), "envision-visions-"))
  try {
    return await fn(repoRoot, testRunInfo({ repoRoot, workRoot: repoRoot, runRoot: `${repoRoot}/.run` }))
  } finally {
    await removeDir(repoRoot)
  }
}

describe("envision-visions", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(envisionVisions.input)) throw new Error("envisionVisions.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(envisionVisions.input)(example)
    if (!isSchemaHandle(envisionVisions.success)) throw new Error("envisionVisions.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(envisionVisions.success)(example)
  })

  test("a missing route retries once and lands, its steady sibling still reaches its own check and commit, and each is dispatched the right number of times", () =>
    withRepo(async (repoRoot, run) => {
      const agent = stubAgent((destination, callNumber) => ({ write: callNumber >= 2 || destination.includes("svelte") }))
      const result = await runWith(envisionVisions.run({ ...INPUT, notations: ["svelte", "effect"] }), agent.service, alwaysCommits, run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.visions).toHaveLength(2)
      expect(result.success.visions.find((v) => v.notation === "svelte")).toBeDefined()
      expect(result.success.visions.find((v) => v.notation === "effect")).toBeDefined()

      const svelteCalls = agent.requests.filter((r) => destinationOf(r.prompt).includes("svelte"))
      const effectCalls = agent.requests.filter((r) => destinationOf(r.prompt).includes("effect"))
      expect(svelteCalls).toHaveLength(1)
      expect(effectCalls).toHaveLength(2)
    }))

  test("a route that misses twice fails the composite with NotationVisionMissing, and its steady sibling still succeeds (siblings are not cancelled by a failing route)", () =>
    withRepo(async (repoRoot, run) => {
      const agent = stubAgent((destination) => ({ write: destination.includes("svelte") }))
      const result = await runWith(envisionVisions.run({ ...INPUT, notations: ["svelte", "effect"] }), agent.service, alwaysCommits, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionMissing)
      expect((result.failure as NotationVisionMissing).notation).toBe("effect")

      const effectCalls = agent.requests.filter((r) => destinationOf(r.prompt).includes("effect"))
      expect(effectCalls).toHaveLength(2)
    }))

  test("a blocked route is dispatched exactly once — a declared failure is trusted, never retried", () =>
    withRepo(async (repoRoot, run) => {
      const agent = stubAgent((destination) =>
        destination.includes("generic") ? { write: false, blocked: "the ticket names no ideal shape to draw" } : { write: true }
      )
      const result = await runWith(envisionVisions.run({ ...INPUT, notations: ["svelte", "generic"] }), agent.service, alwaysCommits, run)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NotationVisionBlocked)

      const genericCalls = agent.requests.filter((r) => destinationOf(r.prompt).includes("generic"))
      expect(genericCalls).toHaveLength(1)
    }))
})
