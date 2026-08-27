import { describe, expect, test } from "bun:test"
import { Data, Schema } from "effect"
import { formatFailure } from "mag/runtime/render"

class InvalidNodeName extends Data.TaggedError("INVALID_NODE_NAME")<{
  readonly name: string
}> {}

class WithMessage extends Data.TaggedError("BAD_INPUT")<{
  readonly message: string
}> {}

describe("formatFailure", () => {
  test("tagged error with no message renders tag + compact JSON of its own fields", () => {
    const error = new InvalidNodeName({ name: "Detect Remote" })

    expect(formatFailure(error)).toBe('INVALID_NODE_NAME: {"name":"Detect Remote"}')
  })

  test("tagged error carrying a non-empty message renders tag: message", () => {
    const error = new WithMessage({ message: "must be kebab-case" })

    expect(formatFailure(error)).toBe("BAD_INPUT: must be kebab-case")
  })

  test("ParseError from a failed decode starts with its tag, is single-line and non-empty", () => {
    const result = Schema.decodeUnknownResult(Schema.Number)("not-a-number")
    if (result._tag !== "Failure") {
      throw new Error("expected decode to fail")
    }
    const parseError = result.failure

    const line = formatFailure(parseError)

    expect(line.length).toBeGreaterThan(0)
    expect(line.includes("\n")).toBe(false)
    expect(line.startsWith(parseError._tag)).toBe(true)
  })

  test("error with neither tag nor enumerable fields renders a stable non-empty fallback", () => {
    const line = formatFailure({})

    expect(line.length).toBeGreaterThan(0)
    expect(line.includes("\n")).toBe(false)
  })
})
