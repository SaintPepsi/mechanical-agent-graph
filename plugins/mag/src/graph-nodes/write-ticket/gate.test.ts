import { describe, expect, test } from "bun:test"
import { droppedCriteria, isOneSentence, parseCriteriaLines } from "mag/graph-nodes/write-ticket/gate"

describe("isOneSentence", () => {
  test("a single sentence, with or without a terminator, passes", () => {
    expect(isOneSentence("Ticket writing costs a session its context.")).toBe(true)
    expect(isOneSentence("Ship it")).toBe(true)
  })

  test("two sentences fail", () => {
    expect(isOneSentence("The API times out. Also the DB crashes.")).toBe(false)
    expect(isOneSentence("Ship it! Then tell the team.")).toBe(false)
  })

  test("empty or whitespace-only fails", () => {
    expect(isOneSentence("")).toBe(false)
    expect(isOneSentence("   ")).toBe(false)
  })

  test("a terminator inside a quoted or abbreviated phrase with no following sentence still passes", () => {
    expect(isOneSentence("Rename the field to `ticket.status`.")).toBe(true)
  })
})

describe("parseCriteriaLines", () => {
  test("one criterion per line, blank lines dropped, surrounding whitespace trimmed", () => {
    expect(parseCriteriaLines("  A first criterion.  \n\nA second criterion.\n\n\n")).toEqual([
      "A first criterion.",
      "A second criterion."
    ])
  })

  test("an all-blank file parses to no criteria", () => {
    expect(parseCriteriaLines("\n\n   \n")).toEqual([])
  })
})

describe("droppedCriteria", () => {
  test("an exact carry (every provided sentence echoed as a source) passes: nothing dropped", () => {
    expect(droppedCriteria(["A first criterion.", "A second criterion."], ["A first criterion.", "A second criterion."])).toEqual([])
  })

  test("extra invented criteria (no source) pass — the provided list is a floor, not a ceiling", () => {
    expect(droppedCriteria(["A first criterion."], ["A first criterion.", undefined])).toEqual([])
  })

  test("a dropped criterion fails, naming it", () => {
    expect(droppedCriteria(["A first criterion.", "A second criterion."], ["A first criterion."])).toEqual([
      "A second criterion."
    ])
  })

  test("matching trims whitespace on both sides before comparing", () => {
    expect(droppedCriteria(["  A first criterion.  "], ["A first criterion."])).toEqual([])
  })

  test("a duplicate provided sentence needs two distinct echoes, not one shared by both", () => {
    expect(droppedCriteria(["Same sentence.", "Same sentence."], ["Same sentence."])).toEqual(["Same sentence."])
    expect(droppedCriteria(["Same sentence.", "Same sentence."], ["Same sentence.", "Same sentence."])).toEqual([])
  })
})
