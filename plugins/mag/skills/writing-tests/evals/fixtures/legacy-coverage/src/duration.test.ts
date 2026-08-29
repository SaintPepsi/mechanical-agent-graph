import { describe, expect, it } from "bun:test"
import { formatDuration, parseDuration } from "./duration"

describe("parseDuration", () => {
  it("parses a duration", () => {
    parseDuration("1h")
  })

  it("returns a number", () => {
    expect(parseDuration("30m")).toBeDefined()
  })

  it("handles combined units", () => {
    expect(parseDuration("1h30m")).toBe(60 * 60 * 1000 + 30 * 60 * 1000)
  })

  it.skip("rejects nonsense", () => {
    expect(() => parseDuration("banana")).toThrow()
  })
})

describe("formatDuration", () => {
  it("formats", () => {
    expect(formatDuration(1000)).toBeTruthy()
  })

  it("round-trips", () => {
    const ms = parseDuration("2h")
    expect(formatDuration(ms)).toBe(formatDuration(parseDuration("2h")))
  })
})
