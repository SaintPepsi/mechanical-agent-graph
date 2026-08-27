import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { issueNumber, prBody } from "mag/runtime/pr-body"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"

const runInfo = (overrides: Partial<RunInfoService> = {}): RunInfoService => ({
  runId: "019bd0f4-3c21-7f1a-9c0e-2f0f2c1a4b77",
  ticket: "GH-231",
  graph: "develop-graph",
  repoRoot: "/repo",
  sha: "abc123",
  pipelineSha: "def456",
  runRoot: "/repo/.claude/graph/run-1",
  workRoot: "/repo",
  recordsRoot: "/repo",
  records: "run-root",
  ...overrides
})

describe("issueNumber", () => {
  // The ticket id's trailing `-`-separated segment — `fetch-ticket` already rejected an id that
  // doesn't reduce to a number, so this derivation stays total, no guard.
  test("GH-231 to 231", () => {
    expect(issueNumber("GH-231")).toBe("231")
  })

  test("a multi-segment id keeps only the trailing numeric suffix", () => {
    expect(issueNumber("feat-GH-231")).toBe("231")
  })

  test("an id that is already bare digits is its own issue number", () => {
    expect(issueNumber("231")).toBe("231")
  })

  test("an id with no `-` is its own trailing segment, `${TICKET##*-}`'s own no-op case", () => {
    expect(issueNumber("noticket")).toBe("noticket")
  })
})

describe("prBody", () => {
  const DESCRIPTION = "Fixes the NUL-byte crash at the artifact writer."

  test("the whole body, by value: the description line, then Closes #<n>, then the run pointer", async () => {
    const body = await Effect.runPromise(
      prBody({ description: DESCRIPTION }).pipe(Effect.provideService(RunInfo, runInfo()))
    )
    expect(body).toBe(`${DESCRIPTION}\n\nCloses #231\n\nrun: 019bd0f4-3c21-7f1a-9c0e-2f0f2c1a4b77`)
  })

  test("as properties: the description is the body's first line, and Closes #<n> stands alone on its own line", async () => {
    const body = await Effect.runPromise(
      prBody({ description: DESCRIPTION }).pipe(Effect.provideService(RunInfo, runInfo()))
    )
    const lines = body.split("\n")
    expect(lines[0]).toBe(DESCRIPTION)
    expect(lines).toContain("Closes #231")
  })

  test("the body carries no review-pass count — a revert goes red", async () => {
    const body = await Effect.runPromise(
      prBody({ description: DESCRIPTION }).pipe(Effect.provideService(RunInfo, runInfo()))
    )
    expect(body).not.toContain("review passes")
  })

  test("a multi-line description keeps Closes #<n> isolated on its own line", async () => {
    const multiline = `${DESCRIPTION}\n\n- Renames \`ships\` to \`description\` on the review verdict.`
    const body = await Effect.runPromise(
      prBody({ description: multiline }).pipe(Effect.provideService(RunInfo, runInfo()))
    )
    const lines = body.split("\n")
    expect(lines[0]).toBe(DESCRIPTION)
    expect(lines).toContain("Closes #231")
    expect(lines.filter((line) => line === "Closes #231")).toHaveLength(1)
  })
})
