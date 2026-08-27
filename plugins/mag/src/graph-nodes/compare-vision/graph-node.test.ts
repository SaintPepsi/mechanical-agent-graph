import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { CompareReportWriteFailed, CompareRunRootMissing } from "mag/graph-nodes/compare-vision/errors"
import { compareVision } from "mag/graph-nodes/compare-vision/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/compare-vision/examples"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { removeDir, testRunInfo } from "mag/test/node-fixture"
import { VisionUnreadable } from "mag/runtime/vision-shape"

/** One step, one edge, one condition — enough for both directions of every element kind to matter. */
const drawing = (nodes: string) =>
  ["```mermaid", "graph TD", '  A["load · Mechanical<br/>job"]', nodes, "```", ""].join("\n")

const MATCHING = drawing('  B["transform · Mechanical<br/>job"]\n  A -- "verdict = ok: record -> record" --> B')
// The shape keys on a box's LABEL text, never its mermaid id (`vision-shape.ts`'s `classify`) — a
// rename has to change the label, `transform` to `convert`, for the reader to see it as one.
const RENAMED = drawing('  B["convert · Mechanical<br/>job"]\n  A -- "verdict = ok: record -> record" --> B')

/** The temp directory plus the two paths every test writes its pair of drawings to. */
const withRunRoot = async <T>(
  fn: (paths: { readonly runRoot: string; readonly visionPath: string; readonly derivedVisionPath: string }) => Promise<T>
): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "compare-vision-"))
  try {
    return await fn({
      runRoot,
      visionPath: join(runRoot, "vision.md"),
      derivedVisionPath: join(runRoot, "derived-vision-1.md")
    })
  } finally {
    await removeDir(runRoot)
  }
}

const runNode = (visionPath: string, derivedVisionPath: string, runRoot: string) =>
  Effect.runPromise(
    Effect.result(
      compareVision.run({ visionPath, derivedVisionPath }).pipe(Effect.provideService(RunInfo, testRunInfo({ runRoot })))
    )
  )

describe("compareVision", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(compareVision.input)) throw new Error("compareVision.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(compareVision.input)(example)
    if (!isSchemaHandle(compareVision.success)) throw new Error("compareVision.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(compareVision.success)(example)
  })

  test("a matching pair yields zero findings and a report saying so", () =>
    withRunRoot(async ({ runRoot, visionPath, derivedVisionPath }) => {
      writeFileSync(visionPath, MATCHING)
      writeFileSync(derivedVisionPath, MATCHING)

      const result = await runNode(visionPath, derivedVisionPath, runRoot)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.findings).toStrictEqual([])
      expect(result.success.divergent).toBe(false)

      expect(readFileSync(result.success.reportPath, "utf8")).toContain("No divergence")
    }))

  test("a renamed node yields exactly the named absent/unexpected findings for every element kind it touches", () =>
    withRunRoot(async ({ runRoot, visionPath, derivedVisionPath }) => {
      writeFileSync(visionPath, MATCHING)
      writeFileSync(derivedVisionPath, RENAMED)

      const result = await runNode(visionPath, derivedVisionPath, runRoot)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.divergent).toBe(true)
      expect([...result.success.findings].sort((a, b) => a.kind.localeCompare(b.kind))).toStrictEqual([
        { kind: "condition-absent-from-code", name: "load -> transform when verdict = ok" },
        { kind: "condition-absent-from-vision", name: "load -> convert when verdict = ok" },
        { kind: "edge-absent-from-code", name: "load -> transform" },
        { kind: "edge-absent-from-vision", name: "load -> convert" },
        { kind: "node-absent-from-code", name: "transform" },
        { kind: "node-absent-from-vision", name: "convert" }
      ])
    }))

  test("an unreadable shipped vision fails VisionUnreadable naming the shipped path", () =>
    withRunRoot(async ({ runRoot, visionPath, derivedVisionPath }) => {
      writeFileSync(visionPath, "# no fenced mermaid here\n")
      writeFileSync(derivedVisionPath, MATCHING)

      const result = await runNode(visionPath, derivedVisionPath, runRoot)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VisionUnreadable)
      expect((result.failure as VisionUnreadable).path).toBe(visionPath)
    }))

  test("an unreadable derived vision fails VisionUnreadable naming the derived path", () =>
    withRunRoot(async ({ runRoot, visionPath, derivedVisionPath }) => {
      writeFileSync(visionPath, MATCHING)
      writeFileSync(derivedVisionPath, "# no fenced mermaid here\n")

      const result = await runNode(visionPath, derivedVisionPath, runRoot)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VisionUnreadable)
      expect((result.failure as VisionUnreadable).path).toBe(derivedVisionPath)
    }))

  test("a run root the report write cannot reach fails CompareReportWriteFailed", () =>
    withRunRoot(async ({ runRoot: base, visionPath, derivedVisionPath }) => {
      writeFileSync(visionPath, MATCHING)
      writeFileSync(derivedVisionPath, MATCHING)

      // `write-pr-body/graph-node.test.ts`'s ENOTDIR trick: a real file sitting where a path
      // component of the run root needs to be a directory.
      const blocker = join(base, "blocker")
      writeFileSync(blocker, "not a directory")
      const brokenRoot = join(blocker, "subdir")

      const result = await runNode(visionPath, derivedVisionPath, brokenRoot)
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(CompareReportWriteFailed)
      expect((result.failure as CompareReportWriteFailed).runRoot).toBe(brokenRoot)
    }))

  test("an empty runRoot is a wiring bug, not a data problem — CompareRunRootMissing before any read", () =>
    withRunRoot(async ({ visionPath, derivedVisionPath }) => {
      writeFileSync(visionPath, MATCHING)
      writeFileSync(derivedVisionPath, MATCHING)

      const result = await runNode(visionPath, derivedVisionPath, "")
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(CompareRunRootMissing)
    }))
})
