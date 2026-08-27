import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Option, Result, Schema } from "effect"
import { ResumeWithoutPredecessor } from "mag/graph-nodes/resume-run/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/resume-run/examples"
import { resumeRun } from "mag/graph-nodes/resume-run/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { ranEndRow, startRow } from "mag/runtime/journal/row"
import { RESUME_RULE } from "mag/runtime/resume"
import { RunRootEnv } from "mag/runtime/run-layers"
import { projectKey } from "mag/runtime/run-root"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir, testJournalStamp } from "mag/test/node-fixture"

/**
 * This node calls the same `selectPredecessor` `runScopedLayers` calls (`graph-node.ts`'s own
 * doc comment), so its own test proves the wiring — decode, repoRoot resolution, ranking, the failure
 * path — not a second copy of the ranking table `runtime/resume.test.ts` already owns.
 *
 * A cross-graph fixture — proving a sibling run of another graph is never chosen — is not authored
 * here: `test/node-fixture.ts`'s `testJournalStamp` fixes its stamped graph to one value on purpose.
 * That case is proven where the fixture can vary it, `runtime/resume.test.ts`.
 */

const REPO_ROOT = "/repo"

const gitToplevel: ShellService = {
  run: (argv): Effect.Effect<ShellResult, never> =>
    Effect.succeed(
      argv.includes("--show-toplevel")
        ? { exitCode: 0, stdout: `${REPO_ROOT}\n`, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: `unscripted call: ${argv.join(" ")}` }
    )
}

const withConfigDir = async (fn: (configDir: string) => Promise<void>): Promise<void> => {
  const configDir = mkdtempSync(join(tmpdir(), "resume-run-"))
  try {
    await fn(configDir)
  } finally {
    await removeDir(configDir)
  }
}

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, configDir: string) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(shellLayer(gitToplevel)),
        Effect.provideService(RunRootEnv, { env: { CLAUDE_CONFIG_DIR: configDir }, home: "/unused" })
      )
    )
  )

/** One sibling run: `count` distinct nodes, each a clean start/end pair, all replayable. Rows come from the journal's own builders, so the fixture cannot drift from the format the scan decodes. */
const writeRun = (configDir: string, runId: string, count: number): void => {
  const dir = join(configDir, "graph", projectKey(REPO_ROOT), "GH-98", runId)
  mkdirSync(dir, { recursive: true })
  const run = {
    ...testJournalStamp({ runId }),
    workRoot: REPO_ROOT,
    recordsRoot: REPO_ROOT,
    records: "run-root" as const,
    runRoot: dir
  }
  const rows = Array.from({ length: count }, (_, index) => {
    const parts = { run, node: `node-${index + 1}`, attempt: 1, input: Option.none(), timestamp: "2026-08-20T00:00:00.000Z" }
    return [
      startRow(parts),
      ranEndRow({ ...parts, exit: Exit.succeed({ done: true }), success: Option.some({ done: true }) })
    ]
  }).flat()
  writeFileSync(join(dir, "journal.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
}

describe("resume-run", () => {
  test("the fixtures decode against resume-run's own schemas", () => {
    if (!isSchemaHandle(resumeRun.input)) throw new Error("resumeRun.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(resumeRun.input)(example)
    if (!isSchemaHandle(resumeRun.success)) throw new Error("resumeRun.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(resumeRun.success)(example)
  })

  test("the success carries the rule and the most-replayable predecessor", () =>
    withConfigDir(async (configDir) => {
      writeRun(configDir, "run-a", 1)
      writeRun(configDir, "run-b", 3)

      const result = await runWith(resumeRun.run({ ticket: "GH-98", graph: "develop-graph" }), configDir)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        predecessorRunId: "run-b",
        journalPath: join(configDir, "graph", projectKey(REPO_ROOT), "GH-98", "run-b", "journal.jsonl"),
        rule: RESUME_RULE,
        replayable: 3
      })
    }))

  test("no sibling run with a replayable row fails ResumeWithoutPredecessor, honest about what was inspected", () =>
    withConfigDir(async (configDir) => {
      writeRun(configDir, "run-a", 0)

      const result = await runWith(resumeRun.run({ ticket: "GH-98", graph: "develop-graph" }), configDir)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ResumeWithoutPredecessor)
      expect(result.failure).toMatchObject({ ticket: "GH-98", graph: "develop-graph", inspected: 1 })
    }))
})
