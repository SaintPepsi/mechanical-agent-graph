import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import {
  ClaudeAgent,
  type ClaudeAgentService,
  ClaudeBin,
  claudeAgentLayer,
  claudeBinLayer,
  ClaudeIsolation,
  claudeIsolationLayer,
  Heartbeat,
  heartbeatLayer,
  isolationFromEnv
} from "mag/runtime/claude/service"
import { liveChildCount } from "mag/runtime/claude/reaper"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"
import { NullVerdict } from "mag/runtime/claude/errors"

/**
 * The seam, exercised the way a node's test will exercise it: a stub service under
 * `claudeAgentLayer`, no binary, no process.
 *
 * The three services are `Context.Reference`s, so a node that reads `ClaudeAgent` keeps `R` at
 * `never` and stays registrable under `runtime/types.ts`'s pin. That claim is checked by
 * `bun run typecheck`, on the `Effect<..., ..., never>` annotation each helper below carries.
 */

const Verdict = Schema.Struct({ status: Schema.Literals(["pass", "fail"]) })
const VERDICT = verdictSchema(Verdict)

/** A node body, written exactly as a real agent-bearing node writes one. */
const reviewNode = (brief: string): Effect.Effect<{ readonly status: "pass" | "fail" }, NullVerdict, never> =>
  Effect.gen(function* () {
    const agent = yield* ClaudeAgent
    const reply = yield* agent.prompt({ prompt: brief, jsonSchema: VERDICT, bounds: { generatingSecs: 120 } })
    return reply.verdict
  }).pipe(Effect.catchTag("CLAUDE_IDLE_TIMEOUT", () => Effect.die("unreachable in these tests")),
    Effect.catchTag("CLAUDE_STARTUP_SILENCE", () => Effect.die("unreachable in these tests")),
    Effect.catchTag("CLAUDE_USAGE_LIMIT", () => Effect.die("unreachable in these tests")),
    Effect.catchTag("CLAUDE_AGENT_EXIT", () => Effect.die("unreachable in these tests")),
    // The transport's sixth tag. Every stub in this file spawns nothing, so the environment
    // check that raises it never runs here either.
    Effect.catchTag("CLAUDE_ENV_REQUIREMENT", () => Effect.die("unreachable in these tests")))

const stub = (prompt: ClaudeAgentService["prompt"]): ClaudeAgentService => ({ prompt })

describe("claudeAgentLayer", () => {
  test("a node runs green against a stub, with no process spawned", () => {
    const seen: Array<string> = []
    const service = stub((request) => {
      seen.push(request.prompt)
      return Effect.succeed({
        verdict: { status: "pass" } as never,
        result: {},
        sessions: ["stub-session"],
        costUsd: 0,
        attempts: 1
      })
    })

    const result = Effect.runSync(
      Effect.result(reviewNode("review this").pipe(Effect.provide(claudeAgentLayer(service))))
    )

    expect(Result.isSuccess(result)).toBe(true)
    expect(seen).toEqual(["review this"])
    expect(liveChildCount()).toBe(0)
  })

  test("the node's schema and bounds reach the service unchanged", () => {
    let bounds: unknown = null
    let serialized = ""
    const service = stub((request) => {
      bounds = request.bounds
      serialized = request.jsonSchema?.serialized ?? ""
      return Effect.succeed({ verdict: { status: "pass" } as never, result: {}, sessions: [], costUsd: null, attempts: 1 })
    })

    Effect.runSync(Effect.result(reviewNode("x").pipe(Effect.provide(claudeAgentLayer(service)))))

    expect(bounds).toEqual({ generatingSecs: 120 })
    expect(serialized).toContain("http://json-schema.org/draft-07/schema#")
  })

  test("a stubbed failure travels to the node as its own tag", () => {
    const service = stub(() =>
      Effect.fail(new NullVerdict({ reason: "unparseable", attempts: 2, sessionId: "s", snippet: "junk" }))
    )

    const result = Effect.runSync(
      Effect.result(reviewNode("x").pipe(Effect.provide(claudeAgentLayer(service))))
    )

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure._tag).toBe("CLAUDE_NULL_VERDICT")
    expect(result.failure.attempts).toBe(2)
  })
})

describe("the references' defaults", () => {
  test("ClaudeBin defaults to claude and claudeBinLayer replaces it", () => {
    expect(Effect.runSync(ClaudeBin)).toBe("claude")
    expect(Effect.runSync(ClaudeBin.pipe(Effect.provide(claudeBinLayer("/tmp/fake"))))).toBe("/tmp/fake")
  })

  test("Heartbeat defaults to a no-op and heartbeatLayer replaces it", () => {
    Effect.runSync(Effect.flatMap(Heartbeat, (h) => h.beat("s", 0)))

    const beats: Array<string> = []
    Effect.runSync(
      Effect.flatMap(Heartbeat, (h) => h.beat("s", 0)).pipe(
        Effect.provide(heartbeatLayer({ beat: (id) => Effect.sync(() => void beats.push(id)) }))
      )
    )
    expect(beats).toEqual(["s"])
  })

  test("ClaudeAgent's default is the live implementation, reached without providing anything", () => {
    const service = Effect.runSync(ClaudeAgent)
    expect(typeof service.prompt).toBe("function")
  })

  test("providing all three at once composes", () => {
    const layer = Layer.mergeAll(
      claudeBinLayer("/tmp/fake"),
      heartbeatLayer({ beat: () => Effect.void }),
      claudeAgentLayer(stub(() => Effect.die("never called")))
    )
    expect(Effect.runSync(ClaudeBin.pipe(Effect.provide(layer)))).toBe("/tmp/fake")
  })

  test("claudeIsolationLayer provides the reference", () => {
    expect(Effect.runSync(ClaudeIsolation.pipe(Effect.provide(claudeIsolationLayer(true))))).toBe(true)
    expect(Effect.runSync(ClaudeIsolation.pipe(Effect.provide(claudeIsolationLayer(false))))).toBe(false)
  })

  // A fresh process per case: `Context.Reference` caches its default on the tag at first
  // unresolved read (effect/src/Context.ts), so an in-process env flip after any read tests the
  // cache, not the wiring. This is the test that dies if the default stops consulting
  // GRAPH_ISOLATE_CONFIG.
  test("ClaudeIsolation's default consults GRAPH_ISOLATE_CONFIG", async () => {
    const read = async (env: Record<string, string>) => {
      const child = Bun.spawn(
        [
          "bun",
          "-e",
          `import { Effect } from "effect"
import { ClaudeIsolation } from "mag/runtime/claude/service"
console.log(Effect.runSync(ClaudeIsolation))`
        ],
        { cwd: import.meta.dir, env: { ...process.env, ...env }, stdout: "pipe" }
      )
      await child.exited
      return (await new Response(child.stdout).text()).trim()
    }
    expect(await read({ GRAPH_ISOLATE_CONFIG: "1" })).toBe("true")
    expect(await read({ GRAPH_ISOLATE_CONFIG: "" })).toBe("false")
  })
})

describe("isolationFromEnv", () => {
  test("GRAPH_ISOLATE_CONFIG=1 is isolated", () => {
    expect(isolationFromEnv({ GRAPH_ISOLATE_CONFIG: "1" })).toBe(true)
  })

  test("absent, empty, and any other value are not isolated", () => {
    expect(isolationFromEnv({})).toBe(false)
    expect(isolationFromEnv({ GRAPH_ISOLATE_CONFIG: "" })).toBe(false)
    expect(isolationFromEnv({ GRAPH_ISOLATE_CONFIG: "true" })).toBe(false)
    expect(isolationFromEnv({ GRAPH_ISOLATE_CONFIG: "0" })).toBe(false)
  })
})
