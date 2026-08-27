import { DateTime, Option } from "effect"
import { type AgentExit, type ResetSource, type TransportError, UsageLimit } from "mag/runtime/claude/errors"

/**
 * Recognising a usage limit and recovering its reset time. Pure: signals in, values out.
 *
 * Rate limiting surfaces on the stream as `type: "system"`, `subtype: "api_retry"`, carrying
 * `error: "rate_limit"`, `error_status: 429`, and `retry_delay_ms` — a delay, so the reset is
 * derived from the moment the event was observed. The result message's `api_error_status` carries
 * the HTTP status. The stderr tail is where a usage-limited `claude -p` says so on the way out,
 * and it is the one source a test can reproduce.
 *
 * Two questions, answered separately: whether this is a rate limit, and when it resets. Keeping
 * them apart means a stray timestamp in an unrelated stderr tail stays unrelated.
 */

/**
 * Phrasing a usage-limited `claude -p` uses on its way out. Each alternative is a whole phrase,
 * because this pattern decides a classification and the cost of a false positive is high: a
 * misclassified crash reports a reset time scraped from an unrelated log line, and a caller that
 * waits for it retries straight back into the same crash.
 *
 * The phrases are what rules the near misses out. A bare `429` matches the line number in
 * `at parse (/app/cli.js:429:17)`; a bare `rate limit` matches `rateLimiter is not a function` and
 * `see docs on rate limits for MCP servers`. None of those is a usage limit.
 */
export const RATE_LIMIT_STDERR =
  /usage limits? (?:reached|exceeded)|rate[ _-]?limits? (?:reached|exceeded)|\b429 too many requests\b/i

/** An ISO string for a millisecond epoch or a parseable date, or `null` when it is neither. */
export const iso = (value: number | string): string | null =>
  Option.match(DateTime.make(value), { onNone: () => null, onSome: DateTime.formatIso })

/** The first timestamp-shaped run in a stderr tail, as an ISO string, or `null`. */
export const resetAtFromStderr = (stderrTail: string): string | null => {
  const match = stderrTail.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/)
  return match ? iso(match[0]) : null
}

/**
 * `observedAtMs + retryDelayMs`, as an ISO string. The `api_retry` event states how long the CLI
 * intends to wait, so the moment it was seen is the other half of the answer.
 *
 * A delay that is not a positive finite number answers `null`: the field belongs to the CLI, and a
 * `NaN` or negative value would otherwise produce a reset time in the past, wearing `api_retry` as
 * its source and reading as authoritative.
 */
export const resetAtFromRetryDelay = (observedAtMs: number, retryDelayMs: number): string | null =>
  Number.isFinite(retryDelayMs) && retryDelayMs > 0 ? iso(observedAtMs + retryDelayMs) : null

/** A rate-limit `api_retry` event as the transport keeps it: what it said, and when. */
export interface RateLimitObservation {
  readonly observedAtMs: number
  readonly retryDelayMs: number
}

/** The signals available once a run has terminated unsuccessfully. */
export interface TerminationSignals {
  readonly apiErrorStatus: number | null
  readonly rateLimit: RateLimitObservation | null
  readonly stderrTail: string
}

/** What a usage limit's reset resolved to, and which signal answered. */
export interface ResetResolution {
  readonly resetAt: string
  readonly source: ResetSource
}

/** Whether the run terminated against a usage limit. */
export const isRateLimited = (signals: TerminationSignals): boolean =>
  signals.apiErrorStatus === 429 ||
  signals.rateLimit !== null ||
  RATE_LIMIT_STDERR.test(signals.stderrTail)

/**
 * The reset time for a run already recognised as rate-limited, in source priority order:
 * `api_error_status` (which contributes the classification and takes the derived time beside it),
 * then the captured `api_retry` delay, then the stderr timestamp. `"none"` states that a usage
 * limit was recognised with no time attached, and `resetAt` stays empty rather than invented.
 */
export const resolveReset = (signals: TerminationSignals): ResetResolution => {
  const derived = signals.rateLimit === null
    ? null
    : resetAtFromRetryDelay(signals.rateLimit.observedAtMs, signals.rateLimit.retryDelayMs)
  if (derived !== null) {
    return { resetAt: derived, source: signals.apiErrorStatus === 429 ? "api_error_status" : "api_retry" }
  }
  const fromStderr = resetAtFromStderr(signals.stderrTail)
  if (fromStderr !== null) return { resetAt: fromStderr, source: "stderr" }
  return { resetAt: "", source: "none" }
}

/**
 * The `CLAUDE_USAGE_LIMIT` these signals earn, or `null` when they describe something else.
 *
 * Every usage limit the transport reports is built here, so the three call sites that need one
 * cannot drift apart on how the classification and the construction line up.
 */
export const asUsageLimit = (signals: TerminationSignals, sessionId: string): UsageLimit | null => {
  if (!isRateLimited(signals)) return null
  const { resetAt, source } = resolveReset(signals)
  return new UsageLimit({ resetAt, source, sessionId })
}

/**
 * The tag a terminated run earns: a usage limit when the signals say so, and the caller's
 * `AgentExit` otherwise. For the call sites where anything other than a usage limit is a failure
 * too; where it is not, use {@link asUsageLimit} directly.
 */
export const terminalFailure = (
  signals: TerminationSignals,
  sessionId: string,
  otherwise: () => AgentExit
): TransportError => asUsageLimit(signals, sessionId) ?? otherwise()
