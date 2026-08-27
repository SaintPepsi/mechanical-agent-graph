import { Data } from "effect"
import type { ShortfallReason } from "mag/runtime/claude/env"

/**
 * The closed transport error union. Every field is a JSON-safe scalar: `runtime/render.ts` renders
 * tagged-error fields through `JSON.stringify`, and a structured field renders as `{}`.
 *
 * Domain failure kinds (`script-exit`, `gate-predicate`, `visit-budget` and the rest) belong to
 * graphs. This union describes what happened to the subprocess and to the verdict it produced, with
 * one exception: {@link EnvRequirement} fires at the composition site before `Bun.spawn` runs, so it
 * describes why no subprocess exists yet, not what one did.
 */

/** Which idle bound elapsed. */
export type IdleBound = "generating" | "tool"

/** Why no usable verdict came back. */
export type NullVerdictReason =
  | "unparseable"
  | "error_max_structured_output_retries"
  | "decode-mismatch"

/** Which source produced a usage limit's reset timestamp. */
export type ResetSource = "api_error_status" | "api_retry" | "stderr" | "none"

/**
 * Which of the six situations `AgentExit` is describing. `stream-error` covers a read failure on
 * the child's own stdout or stderr pipe: an OS-level condition that belongs in the union rather
 * than crossing the boundary as an untagged defect.
 */
export type AgentExitReason =
  | "not-executable"
  | "nonzero-exit"
  | "signal"
  | "no-result-message"
  | "undecodable-result"
  | "stream-error"

/** The generating or tool bound elapsed with no stream activity. */
export class IdleTimeout extends Data.TaggedError("CLAUDE_IDLE_TIMEOUT")<{
  readonly bound: IdleBound
  readonly boundSecs: number
  readonly silentSecs: number
  readonly sessionId: string
  readonly stderrTail: string
}> {}

/**
 * The process produced no `system`/`init` message before the startup bound elapsed. Distinct from
 * {@link IdleTimeout} so a caller can tell "the agent never started" from "the agent stopped
 * mid-answer".
 */
export class StartupSilence extends Data.TaggedError("CLAUDE_STARTUP_SILENCE")<{
  readonly boundSecs: number
  readonly silentSecs: number
  readonly stderrTail: string
}> {}

/**
 * The call completed and produced no usable verdict. `reason` says which of the three routes led
 * here, `attempts` counts the spawns the call made, and `snippet` carries a truncated view of the
 * last raw output.
 */
export class NullVerdict extends Data.TaggedError("CLAUDE_NULL_VERDICT")<{
  readonly reason: NullVerdictReason
  readonly attempts: number
  readonly sessionId: string
  readonly snippet: string
}> {}

/**
 * The five-hour window is spent. `resetAt` is best-effort and may be empty; `source` records which
 * signal answered, so a reader can tell a derived reset from a scraped one.
 */
export class UsageLimit extends Data.TaggedError("CLAUDE_USAGE_LIMIT")<{
  readonly resetAt: string
  readonly source: ResetSource
  readonly sessionId: string
}> {}

/**
 * The process terminated in a way the other five tags do not describe. `reason` is the
 * discriminator; `exitCode` and `signal` carry what the OS reported, raw.
 *
 * `exitCode` is nullable and `signal` exists because a process killed by a signal reports
 * `code: null, signal: "SIGKILL"` — the shape any OOM kill and the watchdog's own kills produce.
 */
export class AgentExit extends Data.TaggedError("CLAUDE_AGENT_EXIT")<{
  readonly reason: AgentExitReason
  readonly exitCode: number | null
  readonly signal: string
  readonly stderrTail: string
  readonly sessionId: string
}> {}

/**
 * A dispatch declared a variable it needs (`SpawnRequest.requires`) and the composed environment
 * does not hold it. `reason` is `envShortfall`'s classification, whose rule that docblock states.
 * Raised before any process starts, so `sessionId` is whatever the dispatch pinned, never one that
 * ran.
 */
export class EnvRequirement extends Data.TaggedError("CLAUDE_ENV_REQUIREMENT")<{
  readonly reason: ShortfallReason
  readonly name: string
  readonly sessionId: string
}> {}

/** Everything the transport can fail with. */
export type TransportError = IdleTimeout | StartupSilence | NullVerdict | UsageLimit | AgentExit | EnvRequirement
