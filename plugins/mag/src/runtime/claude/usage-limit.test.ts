import { describe, expect, test } from "bun:test"
import {
  isRateLimited,
  iso,
  RATE_LIMIT_STDERR,
  resetAtFromRetryDelay,
  resetAtFromStderr,
  resolveReset,
  type TerminationSignals
} from "mag/runtime/claude/usage-limit"

/**
 * Two questions, asserted separately: whether a terminated run hit a usage limit, and when it
 * resets. Keeping them apart is what stops a stray timestamp in an unrelated stderr tail from being
 * read as a usage limit.
 */

const signals = (over: Partial<TerminationSignals>): TerminationSignals => ({
  apiErrorStatus: null,
  rateLimit: null,
  stderrTail: "",
  ...over
})

describe("iso", () => {
  test("turns a millisecond epoch into an ISO string", () => {
    expect(iso(0)).toBe("1970-01-01T00:00:00.000Z")
  })

  test("returns null for an unparseable value", () => {
    expect(iso("not a date")).toBeNull()
  })
})

describe("resetAtFromStderr", () => {
  test("recovers the first timestamp-shaped run in the tail", () => {
    expect(resetAtFromStderr("usage limit reached. Resets at 2026-08-17T22:00:00Z"))
      .toBe("2026-08-17T22:00:00.000Z")
  })

  test("returns null when the tail carries no timestamp", () => {
    expect(resetAtFromStderr("usage limit reached")).toBeNull()
  })
})

describe("resetAtFromRetryDelay", () => {
  test("adds the delay the CLI announced to the moment it was observed", () => {
    expect(resetAtFromRetryDelay(0, 60_000)).toBe("1970-01-01T00:01:00.000Z")
  })

  test("a delay that is not a positive finite number answers null, never a reset in the past", () => {
    expect(resetAtFromRetryDelay(1_000, -60_000)).toBeNull()
    expect(resetAtFromRetryDelay(1_000, Number.NaN)).toBeNull()
    expect(resetAtFromRetryDelay(1_000, Number.POSITIVE_INFINITY)).toBeNull()
    expect(resetAtFromRetryDelay(1_000, 0)).toBeNull()
  })
})

describe("isRateLimited", () => {
  test("a 429 on the result message is a usage limit", () => {
    expect(isRateLimited(signals({ apiErrorStatus: 429 }))).toBe(true)
  })

  test("a captured rate-limit api_retry is a usage limit", () => {
    expect(isRateLimited(signals({ rateLimit: { observedAtMs: 0, retryDelayMs: 1_000 } }))).toBe(true)
  })

  test("the stderr phrasing is a usage limit", () => {
    expect(isRateLimited(signals({ stderrTail: "Claude AI usage limit reached" }))).toBe(true)
    expect(isRateLimited(signals({ stderrTail: "rate_limit exceeded" }))).toBe(true)
    expect(isRateLimited(signals({ stderrTail: "429 Too Many Requests" }))).toBe(true)
  })

  test("a non-429 status alone is an ordinary failure", () => {
    expect(isRateLimited(signals({ apiErrorStatus: 500 }))).toBe(false)
  })

  test("a stderr tail carrying only a timestamp is an ordinary failure", () => {
    expect(isRateLimited(signals({ stderrTail: "crashed at 2026-08-17T22:00:00Z" }))).toBe(false)
  })

  /**
   * The cost of a false positive here is a fabricated reset time: `resolveReset` then scrapes the
   * first timestamp out of an unrelated crash log, and a caller that waits for it retries straight
   * back into the same crash. Each of these three is real stderr text that an earlier, looser
   * pattern matched.
   */
  test("near-miss stderr that is not a usage limit stays an ordinary failure", () => {
    // `\b429\b` matched this line number.
    expect(isRateLimited(signals({ stderrTail: "at parse (/app/cli.js:429:17)" }))).toBe(false)
    // A bare `rate.limit` matched this identifier.
    expect(isRateLimited(signals({ stderrTail: "TypeError: rateLimiter is not a function" }))).toBe(false)
    // And this piece of documentation prose.
    expect(isRateLimited(signals({ stderrTail: "see docs on rate limits for MCP servers" }))).toBe(false)
  })

  test("RATE_LIMIT_STDERR matches phrases, so an unrelated tail stays unmatched", () => {
    expect(RATE_LIMIT_STDERR.test("permission denied")).toBe(false)
  })
})

describe("resolveReset", () => {
  test("a 429 beside a captured delay answers as api_error_status", () => {
    expect(resolveReset(signals({
      apiErrorStatus: 429,
      rateLimit: { observedAtMs: 0, retryDelayMs: 60_000 }
    }))).toEqual({ resetAt: "1970-01-01T00:01:00.000Z", source: "api_error_status" })
  })

  test("a captured delay with no status answers as api_retry", () => {
    expect(resolveReset(signals({ rateLimit: { observedAtMs: 0, retryDelayMs: 60_000 } })))
      .toEqual({ resetAt: "1970-01-01T00:01:00.000Z", source: "api_retry" })
  })

  test("the stderr timestamp answers when no event was captured", () => {
    expect(resolveReset(signals({ stderrTail: "Resets at 2026-08-17T22:00:00Z" })))
      .toEqual({ resetAt: "2026-08-17T22:00:00.000Z", source: "stderr" })
  })

  test("a usage limit with no time attached reports source none and an empty resetAt", () => {
    expect(resolveReset(signals({ apiErrorStatus: 429 }))).toEqual({ resetAt: "", source: "none" })
  })
})
