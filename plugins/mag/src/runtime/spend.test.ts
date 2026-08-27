import { describe, expect, test } from "bun:test"
import { charge, NO_SPEND } from "mag/runtime/spend"

describe("spend", () => {
  test("charges add up in order, sessions appended", () => {
    const spent = charge(charge(NO_SPEND, ["a"], 0.5), ["b", "c"], 0.25)
    expect(spent).toStrictEqual({ costUsd: 0.75, sessions: ["a", "b", "c"] })
  })

  test("one unpriced pass poisons the total, and the poison survives later priced passes", () => {
    const spent = charge(charge(charge(NO_SPEND, ["a"], 0.5), ["b"], null), ["c"], 0.25)
    expect(spent).toStrictEqual({ costUsd: null, sessions: ["a", "b", "c"] })
  })
})
