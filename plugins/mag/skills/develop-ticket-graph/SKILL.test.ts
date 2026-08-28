import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Exit, Runtime } from "effect"
import * as buildUnderReviewErrors from "mag/graph-nodes/build-under-review/errors"
import * as designUnderReviewErrors from "mag/graph-nodes/design-under-review/errors"
import { PlanBlocked, PlanDisputeRejected } from "mag/graph-nodes/review-plan/errors"
import { VerificationFailed } from "mag/graph-nodes/verification/errors"

/**
 * Pins the run-outcome section's claims to the real exported symbols they describe, so a future
 * edit that drifts the doc from the code (or the code from the doc) fails loudly instead of
 * silently. The four closing lines themselves are already pinned to `formatEventLine` by
 * `runtime/trace/console-sink.test.ts`; here only the doc's copy of them is checked.
 */
const SKILL = readFileSync(join(import.meta.dirname, "SKILL.md"), "utf8")

describe("run-outcome section — the four console-sink outcomes it names", () => {
  test("SKILL.md quotes the DIE and INTERRUPT closing lines verbatim", () => {
    expect(SKILL).toContain("mag: [develop-graph] DIE <TAG> <secs>")
    expect(SKILL).toContain("mag: [develop-graph] INTERRUPT <secs>")
  })

  test("exit codes the section states match effect's own teardown: interrupt-only is 130, everything else defaults to 1", () => {
    const codes: number[] = []
    const record = (code: number) => codes.push(code)

    Runtime.defaultTeardown(Exit.succeed(undefined), record)
    Runtime.defaultTeardown(Exit.interrupt(), record)
    Runtime.defaultTeardown(Exit.fail({ _tag: "ANYTHING" }), record)

    expect(codes).toEqual([0, 130, 1])
    expect(SKILL).toContain("130 on `INTERRUPT`")
  })
})

describe("run-outcome section — VERIFICATION_FAILED gets a named route", () => {
  test("VerificationFailed's fields are exactly what the section's own bullet lists, reportPath stands alongside exitCode/outputTail, and it still isn't the review path-field bucket", () => {
    const failure = new VerificationFailed({
      command: "bun run test",
      exitCode: 1,
      outputTail: "FAIL: some_test",
      reportPath: "/repo/.claude/graph/GH-98/run-1/verification-1.txt"
    })

    expect(Object.keys(failure)).toEqual(expect.arrayContaining(["command", "exitCode", "outputTail", "reportPath"]))
    // reportPath is VerificationFailed's own path field, not the review verdicts' findingsPath/
    // disputePath, so it still routes to VERIFICATION_FAILED's own bullet rather than the generic
    // "A path field" one above, the guidance differs (fix the code, not read a review verdict).
    expect("findingsPath" in failure).toBe(false)
    expect("disputePath" in failure).toBe(false)
  })

  test("SKILL.md names VERIFICATION_FAILED its own triage bullet, distinct from the generic host-field bucket", () => {
    expect(SKILL).toContain("**`VERIFICATION_FAILED`**")
    expect(SKILL).toContain("outputTail")
    expect(SKILL).toContain("reportPath")
  })
})

describe("run-outcome section — summaryPath is not a develop-graph failure field", () => {
  test("BuildDisputed (the only error carrying summaryPath) is excluded from build-under-review's own error re-export", () => {
    // build-under-review/errors.ts re-exports build's union minus BUILD_DISPUTED, for the reason
    // that file states: the composite catches that tag itself, on graph-node.ts's own edge. If
    // this ever starts re-exporting it, the "no path field named summaryPath reaches develop-graph"
    // claim below would need to change with it.
    expect("BuildDisputed" in buildUnderReviewErrors).toBe(false)
  })

  test("SKILL.md's path-field bullet lists the review verdicts' two path fields, and not summaryPath", () => {
    expect(SKILL).toContain("`findingsPath`, `disputePath`)")
    expect(SKILL).toContain("never reaches this line")
  })

  test("SKILL.md's path-field bullet names review-plan's two tags beside review-diff's, and both carry findingsPath", () => {
    expect(SKILL).toContain("`PLAN_BLOCKED`")
    expect(SKILL).toContain("`PLAN_DISPUTE_REJECTED`")
    const blocked = new PlanBlocked({ findingsPath: "/run/review-plan-1.md", headSha: "abc", sessions: [], costUsd: null })
    const rejected = new PlanDisputeRejected({ findingsPath: "/run/review-plan-2.md", disputePath: "/run/dispute-1.md", headSha: "abc", sessions: [], costUsd: null })
    expect("findingsPath" in blocked && "findingsPath" in rejected && "disputePath" in rejected).toBe(true)
    expect("PlanBlocked" in designUnderReviewErrors && "PlanDisputeRejected" in designUnderReviewErrors).toBe(true)
  })
})

describe("ticket-writer is named as the way to write a new ticket", () => {
  test("SKILL.md's outcome section states quiet on green: the PR URL and the count line, the full report only on failure", () => {
    expect(SKILL).toContain("a green run reports the PR URL and the closing count line, nothing else")
    expect(SKILL).toContain("a failed\nrun gets the full report")
  })

  test("SKILL.md names the ticket-writer command", () => {
    expect(SKILL).toContain("ticket-writer")
  })
})

