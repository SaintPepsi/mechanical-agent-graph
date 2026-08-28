import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { issueNumber, prBody } from "mag/runtime/pr-body"
import { RunInfo } from "mag/runtime/run-info"
import { testRunInfo, withRunRoot } from "mag/test/node-fixture"

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
  const RUN_ID = "019bd0f4-3c21-7f1a-9c0e-2f0f2c1a4b77"

  /** Stands in for `write-pr-body`'s own artifact, then composes the body into the same run root and reads it back. */
  const composed = (description: string) =>
    withRunRoot("pr-body", async (runRoot) => {
      const descriptionPath = join(runRoot, "pr-description-1.md")
      writeFileSync(descriptionPath, description)
      const bodyPath = await Effect.runPromise(
        prBody({ descriptionPath }).pipe(Effect.provideService(RunInfo, testRunInfo({ runRoot, ticket: "GH-231", runId: RUN_ID })))
      )
      return { bodyPath, body: readFileSync(bodyPath, "utf8"), runRoot }
    })

  test("the whole body, as a run-root file: the description, then Closes #<n>, then the run pointer", async () => {
    const { bodyPath, body, runRoot } = await composed(DESCRIPTION)
    expect(bodyPath).toBe(`${runRoot}/pr-body-1.md`)
    expect(body).toBe(`${DESCRIPTION}\n\nCloses #231\n\nrun: ${RUN_ID}`)
  })

  test("as properties: the description is the body's first line, and Closes #<n> stands alone on its own line", async () => {
    const lines = (await composed(DESCRIPTION)).body.split("\n")
    expect(lines[0]).toBe(DESCRIPTION)
    expect(lines).toContain("Closes #231")
  })

  test("the body carries no review-pass count — a revert goes red", async () => {
    expect((await composed(DESCRIPTION)).body).not.toContain("review passes")
  })

  test("a multi-line description keeps Closes #<n> isolated on its own line", async () => {
    const multiline = `${DESCRIPTION}\n\n- Renames \`ships\` to \`description\` on the review verdict.`
    const lines = (await composed(multiline)).body.split("\n")
    expect(lines[0]).toBe(DESCRIPTION)
    expect(lines.filter((line) => line === "Closes #231")).toHaveLength(1)
  })
})
