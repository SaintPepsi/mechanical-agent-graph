import { describe, expect, test } from "bun:test"
import { extractJsonObject, parseResult, stripFences } from "mag/runtime/claude/verdict"

/**
 * The schemaless parsing chain, pinned on hand-written strings. Every case here is a shape a real
 * `claude -p` reply has taken: fenced JSON, prose wrapped around an object, an object nested inside
 * an unparseable outer span, and braces inside string values.
 */

describe("stripFences", () => {
  test("strips a ```json fence pair, leaving the payload", () => {
    expect(stripFences("```json\n{\"a\":1}\n```")).toBe("{\"a\":1}")
  })

  test("strips a bare ``` fence pair", () => {
    expect(stripFences("```\n{\"a\":1}\n```")).toBe("{\"a\":1}")
  })

  test("returns unfenced text unchanged", () => {
    expect(stripFences("{\"a\":1}")).toBe("{\"a\":1}")
  })
})

describe("extractJsonObject", () => {
  test("finds an object surrounded by prose", () => {
    expect(extractJsonObject("Here you go: {\"status\":\"pass\"} — hope that helps."))
      .toEqual({ status: "pass" })
  })

  test("the largest parseable span wins, so the whole object beats a nested fragment", () => {
    expect(extractJsonObject("{\"outer\":{\"inner\":1}}")).toEqual({ outer: { inner: 1 } })
  })

  test("an unparseable outer span leaves an inner object still reachable", () => {
    expect(extractJsonObject("{status: {\"inner\":1}}")).toEqual({ inner: 1 })
  })

  test("returns null when nothing in the text parses as an object", () => {
    expect(extractJsonObject("no json here at all")).toBeNull()
  })

  test("a bare array is not a verdict", () => {
    expect(extractJsonObject("[1,2,3]")).toBeNull()
  })

  test("braces inside a string value do not close the object", () => {
    expect(extractJsonObject("{\"a\":\"}}}\"}")).toEqual({ a: "}}}" })
  })

  test("a backslash inside a string escapes the next character", () => {
    expect(extractJsonObject("{\"a\":\"\\\"}\"}")).toEqual({ a: "\"}" })
  })

  test("returns null when the object never closes", () => {
    expect(extractJsonObject("{\"a\":1")).toBeNull()
  })

  test("a stray closing brace before the object does not consume it", () => {
    expect(extractJsonObject("} {\"a\":1}")).toEqual({ a: 1 })
  })

  /**
   * The prose around the object is not JSON, so its quotes carry no structure. Tracking string
   * state across the whole reply instead of per candidate makes one unpaired `"` swallow every
   * brace after it, and these are the replies that produced it.
   */
  test("an unpaired quote in the prose before the object does not hide it", () => {
    expect(extractJsonObject("The 5\" panel is fine. Verdict: {\"status\": \"pass\"}"))
      .toEqual({ status: "pass" })
    expect(extractJsonObject("She said \"start now. {\"ok\": true}")).toEqual({ ok: true })
  })

  test("an odd number of quotes after the object does not hide it either", () => {
    expect(extractJsonObject("{\"status\":\"pass\"} — that's a 3\" margin")).toEqual({ status: "pass" })
  })
})

describe("parseResult", () => {
  test("parses a fenced object", () => {
    expect(parseResult("```json\n{\"status\":\"pass\"}\n```")).toEqual({ status: "pass" })
  })

  test("falls through to the embedded scan when the whole string will not parse", () => {
    expect(parseResult("Sure!\n```json\n{\"status\":\"pass\"}\n```\nDone.")).toEqual({ status: "pass" })
  })

  test("returns null for a missing result", () => {
    expect(parseResult(null)).toBeNull()
    expect(parseResult(undefined)).toBeNull()
  })

  test("returns null when the reply parses to a scalar", () => {
    expect(parseResult("42")).toBeNull()
  })
})
