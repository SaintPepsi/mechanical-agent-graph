import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { TestSmellsUnreadable } from "mag/graph-nodes/test-smells/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/test-smells/examples"
import { testSmells } from "mag/graph-nodes/test-smells/graph-node"
import { inspectSource } from "mag/graph-nodes/test-smells/smells"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

/** The five seeded flaws the skill's checker is calibrated on, one test each, plus two clean tests. */
const SEEDED = `
import { describe, expect, test } from "bun:test"
describe("limiter", () => {
  test("asserts nothing", () => {
    limiter.check("k")
  })
  test("floating then", () => {
    limiter.check("k").then((r) => expect(r).toBe(true))
  })
  test("floating resolves", () => {
    expect(limiter.check("k")).resolves.toBe(true)
  })
  test("forEach async", async () => {
    ;[1, 2].forEach(async (n) => { await expect(limiter.check(n)).resolves.toBe(true) })
  })
  test("weak only", () => {
    expect(limiter.check("k")).toBeDefined()
  })
  test("clean literal", () => {
    expect(limiter.check("k")).toStrictEqual({ ok: true, remaining: 4 })
  })
  test("clean throw", () => {
    expect(() => limiter.check("")).toThrow("empty key")
  })
})
`

const CLEAN = `
import { expect, test } from "bun:test"
test("adds", () => {
  expect(add(2, 3)).toBe(5)
})
`

const runAt = (workRoot: string, testPaths: readonly string[]) =>
  Effect.runPromise(
    Effect.result(testSmells.run({ testPaths }).pipe(Effect.provideService(RunInfo, testRunInfo({ workRoot }))))
  )

describe("test-smells", () => {
  test("the fixtures decode against test-smells's own schemas", () => {
    if (!isSchemaHandle(testSmells.input)) throw new Error("testSmells.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(testSmells.input)(example)
    if (!isSchemaHandle(testSmells.success)) throw new Error("testSmells.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(testSmells.success)(example)
  })

  test("the ported checker names each seeded flaw by rule and line, and nothing on the clean tests", () => {
    const inspected = inspectSource("seeded.test.ts", SEEDED)
    expect(inspected.tests).toBe(7)
    expect(inspected.findings.map((finding) => [finding.severity, finding.rule, finding.line])).toStrictEqual([
      ["error", "no-assertion", 4],
      ["error", "assertion-in-floating-then", 8],
      ["error", "floating-async-matcher", 11],
      ["error", "async-callback-in-loop", 14],
      ["warn", "weak-assertion-only", 16]
    ])
    expect(inspected.testRecords.filter((record) => record.dead).map((record) => record.name)).toStrictEqual([
      "asserts nothing",
      "weak only"
    ])
  })

  test("a clean file has no findings, and the count says the file was actually read", () => {
    expect(inspectSource("clean.test.ts", CLEAN)).toStrictEqual({
      path: "clean.test.ts",
      findings: [],
      tests: 1,
      testRecords: [{ name: "adds", line: 3, matchers: ["toBe"], asserts: true, dead: false }]
    })
  })

  test("the node reads each path under workRoot and folds every file's findings and count", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "test-smells-"))
    try {
      writeFileSync(join(workRoot, "seeded.test.ts"), SEEDED)
      writeFileSync(join(workRoot, "clean.test.ts"), CLEAN)
      const result = await runAt(workRoot, ["seeded.test.ts", "clean.test.ts"])

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.tests).toBe(8)
      expect(result.success.findings.map((finding) => finding.rule)).toStrictEqual([
        "no-assertion",
        "assertion-in-floating-then",
        "floating-async-matcher",
        "async-callback-in-loop",
        "weak-assertion-only"
      ])
      expect(result.success.findings.every((finding) => finding.path === "seeded.test.ts")).toBe(true)
    } finally {
      await removeDir(workRoot)
    }
  })

  test("a path that cannot be read is TestSmellsUnreadable, never a clean report for a file never inspected", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "test-smells-"))
    try {
      const result = await runAt(workRoot, ["missing.test.ts"])
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TestSmellsUnreadable)
      expect((result.failure as TestSmellsUnreadable).path).toBe("missing.test.ts")
    } finally {
      await removeDir(workRoot)
    }
  })
})
