import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { VerifyEscapesRunRootMissing, VerifyEscapesSuiteRed } from "mag/graph-nodes/verify-escapes/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/verify-escapes/examples"
import { verifyEscapes } from "mag/graph-nodes/verify-escapes/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { removeDir, testRunInfo } from "mag/test/node-fixture"

/**
 * A real tree and the real shell, on purpose: the claims this node exists to refute are refuted
 * by running things, and a scripted shell that answered "green" would prove nothing about whether
 * the mutation was applied, the probe was run against it, or the bytes came back.
 */
const ORIGINAL = "answer=42\nkey=present\n"
/** Green exactly while the `answer=` key survives; blind to the value, which is the hole a breaker exploits. */
const SUITE = "grep -q '^answer=' src.txt"
const PROBE = "cat src.txt"

const claim = (overrides: Partial<{ path: string; find: string; replace: string; probeSource: string }>) => ({
  path: "src.txt",
  find: "42",
  replace: "43",
  probeSource: PROBE,
  rationale: "changes the answer",
  ...overrides
})

const withTree = async <T>(fn: (workRoot: string, runRoot: string) => Promise<T>): Promise<T> => {
  const workRoot = mkdtempSync(join(tmpdir(), "verify-escapes-work-"))
  const runRoot = mkdtempSync(join(tmpdir(), "verify-escapes-run-"))
  try {
    writeFileSync(join(workRoot, "src.txt"), ORIGINAL)
    return await fn(workRoot, runRoot)
  } finally {
    await removeDir(workRoot)
    await removeDir(runRoot)
  }
}

const runAt = (workRoot: string, runRoot: string, claims: readonly ReturnType<typeof claim>[], command = SUITE) =>
  Effect.runPromise(
    Effect.result(
      verifyEscapes.run({ claims, command }).pipe(Effect.provideService(RunInfo, testRunInfo({ workRoot, runRoot })))
    )
  )

describe("verify-escapes", () => {
  test("the fixtures decode against verify-escapes's own schemas", () => {
    if (!isSchemaHandle(verifyEscapes.input)) throw new Error("verifyEscapes.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(verifyEscapes.input)(example)
    if (!isSchemaHandle(verifyEscapes.success)) throw new Error("verifyEscapes.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(verifyEscapes.success)(example)
  })

  test("a claim the suite misses and the probe observes survives, rationale dropped", () =>
    withTree(async (workRoot, runRoot) => {
      const result = await runAt(workRoot, runRoot, [claim({})])

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({
        escapes: [{ path: "src.txt", find: "42", replace: "43", probeSource: PROBE }],
        tried: 1
      })
    }))

  test("a claim that turns the suite red dies", () =>
    withTree(async (workRoot, runRoot) => {
      const result = await runAt(workRoot, runRoot, [claim({ find: "answer=", replace: "broken=" })])

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ escapes: [], tried: 1 })
    }))

  test("a claim whose probe cannot tell the trees apart dies", () =>
    withTree(async (workRoot, runRoot) => {
      const result = await runAt(workRoot, runRoot, [claim({ probeSource: "echo constant" })])

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ escapes: [], tried: 1 })
    }))

  test("a find that is absent, ambiguous, or in a file that does not exist is discarded without touching the tree", () =>
    withTree(async (workRoot, runRoot) => {
      const result = await runAt(workRoot, runRoot, [
        claim({ find: "nope" }),
        claim({ find: "e" }),
        claim({ path: "missing.txt" })
      ])

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ escapes: [], tried: 3 })
      // No probe was ever written: discarding happened before any run.
      expect(readdirSync(runRoot)).toStrictEqual([])
    }))

  test("after every claim, surviving or not, the file is byte-identical to the original", () =>
    withTree(async (workRoot, runRoot) => {
      await runAt(workRoot, runRoot, [
        claim({}),
        claim({ find: "answer=", replace: "broken=" }),
        claim({ probeSource: "echo constant" })
      ])
      expect(readFileSync(join(workRoot, "src.txt"), "utf8")).toBe(ORIGINAL)
      // One probe script per tried claim, numbered by the run root's own count.
      expect(readdirSync(runRoot).sort()).toStrictEqual(["probe-1.sh", "probe-2.sh", "probe-3.sh"])
      expect(readFileSync(join(runRoot, "probe-3.sh"), "utf8")).toBe("echo constant")
    }))

  test("a suite red before any mutation is VerifyEscapesSuiteRed, and no claim is tried", () =>
    withTree(async (workRoot, runRoot) => {
      const result = await runAt(workRoot, runRoot, [claim({})], "grep -q '^absent=' src.txt")

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VerifyEscapesSuiteRed)
      expect((result.failure as VerifyEscapesSuiteRed).exitCode).toBe(1)
      expect(readdirSync(runRoot)).toStrictEqual([])
      expect(readFileSync(join(workRoot, "src.txt"), "utf8")).toBe(ORIGINAL)
    }))

  test("no run root is VerifyEscapesRunRootMissing before the suite runs", () =>
    withTree(async (workRoot) => {
      const result = await Effect.runPromise(
        Effect.result(
          verifyEscapes.run({ claims: [claim({})], command: SUITE }).pipe(
            Effect.provideService(RunInfo, testRunInfo({ workRoot, runRoot: "" }))
          )
        )
      )
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VerifyEscapesRunRootMissing)
    }))
})
