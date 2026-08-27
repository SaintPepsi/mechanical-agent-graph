import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { DetectJsTestsNoPaths } from "mag/graph-nodes/detect-js-tests/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/detect-js-tests/examples"
import { detectJsTests } from "mag/graph-nodes/detect-js-tests/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"

describe("detect-js-tests", () => {
  test("the fixtures decode against detect-js-tests's own schemas", () => {
    if (!isSchemaHandle(detectJsTests.input)) throw new Error("detectJsTests.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(detectJsTests.input)(example)
    if (!isSchemaHandle(detectJsTests.success)) throw new Error("detectJsTests.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(detectJsTests.success)(example)
  })

  // `Effect.runSync` typechecks only against a `never` requirement: the probe reads nothing.
  test("matches on any JS/TS extension and keeps only those paths, in order", () => {
    const value = Effect.runSync(
      detectJsTests.run({ testPaths: ["tests/test_a.py", "a.test.ts", "b.spec.mjs", "c.test.tsx", "README.md"] })
    )
    expect(value).toStrictEqual({ matched: true, paths: ["a.test.ts", "b.spec.mjs", "c.test.tsx"] })
  })

  test("no JS/TS path is a clean non-match, not a failure", () => {
    expect(Effect.runSync(detectJsTests.run({ testPaths: ["tests/test_a.py"] }))).toStrictEqual({ matched: false, paths: [] })
  })

  test("an empty list is DetectJsTestsNoPaths", () => {
    const result = Effect.runSync(Effect.result(detectJsTests.run({ testPaths: [] })))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(DetectJsTestsNoPaths)
  })
})
