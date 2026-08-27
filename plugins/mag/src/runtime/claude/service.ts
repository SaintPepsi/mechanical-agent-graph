import { Context, Effect, Layer } from "effect"
import { liveClaudeAgent } from "mag/runtime/claude/agent"
import type { TransportError } from "mag/runtime/claude/errors"
import { DEFAULT_TIMING, type IdleBounds, type SpawnTiming } from "mag/runtime/claude/spawn"
import type { VerdictSchema } from "mag/runtime/claude/verdict-schema"

/**
 * The service seam. `ClaudeAgent`, `ClaudeBin` and `Heartbeat` are each a `Context.Reference` with
 * a `defaultValue`, matching every custom service in this codebase (`TraceSinks`, `RunId`, `Shell`).
 * A `Reference` resolves with nothing provided, which is what keeps a node's `R` at `never` — the
 * pin `runtime/types.ts` applies to anything the CLI can reach.
 */

/** One `claude -p` invocation, named after the flags it becomes. */
export interface ClaudePrint<A> {
  /** The positional prompt argument. */
  readonly prompt: string
  /** `--json-schema`. Its presence makes this a schema'd call. */
  readonly jsonSchema?: VerdictSchema<A>
  /** `--model`, overrides the agent's pinned frontmatter — probe recorded on `SpawnRequest.model`. */
  readonly model?: string
  /** `--agent`: run the session as a named agent from the target repo's `.claude/agents/`. */
  readonly agent?: string
  /** `--resume` */
  readonly resume?: string
  /** `--session-id` */
  readonly sessionId?: string
  /** The watchdog's bounds. No flag behind it. */
  readonly bounds?: Partial<IdleBounds>
  /** The child's working directory. Omitted means inherit, current behaviour. No flag behind it. */
  readonly cwd?: string
  /** Names this call's work needs present in the child's environment. No flag behind it. */
  readonly requires?: readonly string[]
}

/** What one `prompt` call produced. */
export interface ClaudeReply<A> {
  /** Decoded through the call's `VerdictSchema`, or the raw object for a schemaless call. */
  readonly verdict: A
  /** The CLI's own final message, decoded, wire field names intact. */
  readonly result: unknown
  /** Every session id this call touched, deduped, the pinned id first. */
  readonly sessions: readonly string[]
  /** Summed across every spawn the call made. */
  readonly costUsd: number | null
  /** How many spawns the call made. */
  readonly attempts: number
}

export interface ClaudeAgentService {
  readonly prompt: <A>(request: ClaudePrint<A>) => Effect.Effect<ClaudeReply<A>, TransportError>
}

/**
 * Writes the live pointer a supervisor reads: which session is running, and when it last showed a
 * sign of life. The default is a no-op, so the transport never learns where that file lives.
 */
export interface HeartbeatService {
  readonly beat: (sessionId: string, beatEpochSecs: number) => Effect.Effect<void>
}

export const Heartbeat = Context.Reference<HeartbeatService>("mag/runtime/claude/Heartbeat", {
  defaultValue: (): HeartbeatService => ({ beat: () => Effect.void })
})

/** Provide a `HeartbeatService` — the run's live-pointer writer, or a recorder in tests. */
export const heartbeatLayer = (service: HeartbeatService): Layer.Layer<never> =>
  Layer.succeed(Heartbeat, service)

/**
 * Which binary to spawn. A fixture script in the tests that need a real process, `claude` in
 * production. Same `Context.Reference`-with-default pattern as every other custom service here.
 */
export const ClaudeBin = Context.Reference<string>("mag/runtime/claude/ClaudeBin", {
  defaultValue: () => "claude"
})

/** Provide a specific binary path. */
export const claudeBinLayer = (bin: string): Layer.Layer<never> => Layer.succeed(ClaudeBin, bin)

/**
 * The watchdog's own clock. Injected for the same reason `ClaudeBin` is: a test that shrinks an
 * idle bound to one second still waits a full `pollMs` tick and `termGraceMs` grace, because the
 * watchdog's schedule ticks on its own clock whatever the bound says.
 */
export const ClaudeTiming = Context.Reference<SpawnTiming>("mag/runtime/claude/ClaudeTiming", {
  defaultValue: () => DEFAULT_TIMING
})

/** Provide millisecond-scale timing, so a bounds test costs milliseconds rather than seconds. */
export const claudeTimingLayer = (timing: Partial<SpawnTiming>): Layer.Layer<never> =>
  Layer.succeed(ClaudeTiming, { ...DEFAULT_TIMING, ...timing })

/** Pure read of `GRAPH_ISOLATE_CONFIG`. `"1"` and nothing else means isolated. */
export const isolationFromEnv = (env: Record<string, string | undefined>): boolean =>
  env["GRAPH_ISOLATE_CONFIG"] === "1"

/**
 * Whether a spawned session runs isolated from the invoker's local `~/.claude`. A run-wide policy,
 * not a per-call argument (`ClaudePrint` carries no field for it): `liveClaudeAgent` reads this once
 * and carries it onto every spawn a call makes. The env default is effectively once-per-process,
 * not once-per-read — `Context.Reference` caches the default on the tag at its first unresolved
 * read — which is exactly what a run-wide policy wants.
 */
export const ClaudeIsolation = Context.Reference<boolean>("mag/runtime/claude/ClaudeIsolation", {
  defaultValue: () => isolationFromEnv(process.env)
})

/** Provide a fixed isolation policy, so a test does not depend on `GRAPH_ISOLATE_CONFIG`. */
export const claudeIsolationLayer = (isolated: boolean): Layer.Layer<never> =>
  Layer.succeed(ClaudeIsolation, isolated)

/**
 * The one service an agent-bearing node declares. Its default value is the live implementation, so
 * a node runs against a real `claude -p` with nothing provided and against a stub under
 * `claudeAgentLayer` in tests.
 *
 * `defaultValue` is a thunk, and `agent.ts` reads `ClaudeBin` and `Heartbeat` from this module: the
 * live implementation is therefore looked up on first use, after both modules have finished
 * evaluating.
 */
export const ClaudeAgent = Context.Reference<ClaudeAgentService>("mag/runtime/claude/ClaudeAgent", {
  defaultValue: (): ClaudeAgentService => liveClaudeAgent
})

/** Provide a specific `ClaudeAgentService` — a stub in tests, the live one in production. */
export const claudeAgentLayer = (service: ClaudeAgentService): Layer.Layer<never> =>
  Layer.succeed(ClaudeAgent, service)
