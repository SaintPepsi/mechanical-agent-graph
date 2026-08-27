import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { canonicalJson, sameInput } from "mag/runtime/journal/canonical"

const rendered = (value: unknown): string => Option.getOrThrow(canonicalJson(value))

describe("canonicalJson", () => {
  test("key order does not change the rendering", () => {
    expect(rendered({ ticket: "GH-1", title: "a" })).toBe(rendered({ title: "a", ticket: "GH-1" }))
  })

  test("nested keys sort too", () => {
    expect(rendered({ outer: { b: 1, a: 2 } })).toBe('{"outer":{"a":2,"b":1}}')
  })

  test("array order is preserved, because array order is meaning", () => {
    expect(rendered([3, 1, 2])).toBe("[3,1,2]")
    expect(rendered([1, 2, 3])).not.toBe(rendered([3, 2, 1]))
  })

  test("array elements are canonicalised in place", () => {
    expect(rendered([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  test("primitives and null render as themselves", () => {
    expect(rendered("x")).toBe('"x"')
    expect(rendered(7)).toBe("7")
    expect(rendered(true)).toBe("true")
    expect(rendered(null)).toBe("null")
  })

  test("a value with no rendering is None rather than a throw", () => {
    expect(canonicalJson(undefined)).toStrictEqual(Option.none())
    expect(canonicalJson(1n)).toStrictEqual(Option.none())

    const cycle: Record<string, unknown> = {}
    cycle["self"] = cycle
    expect(canonicalJson(cycle)).toStrictEqual(Option.none())
  })
})

describe("sameInput", () => {
  test("the same input in a different key order matches", () => {
    expect(sameInput(Option.some({ a: 1, b: 2 }), Option.some({ b: 2, a: 1 }))).toBe(true)
  })

  test("a different input does not match", () => {
    expect(sameInput(Option.some({ ticket: "GH-1" }), Option.some({ ticket: "GH-2" }))).toBe(false)
  })

  test("an absent input on either side is a mismatch, so the node runs fresh", () => {
    expect(sameInput(Option.none(), Option.some({ a: 1 }))).toBe(false)
    expect(sameInput(Option.some({ a: 1 }), Option.none())).toBe(false)
    expect(sameInput(Option.none(), Option.none())).toBe(false)
  })

  test("an unrenderable input on either side is a mismatch", () => {
    expect(sameInput(Option.some(1n), Option.some(1n))).toBe(false)
  })

  test("absent and present fields are told apart", () => {
    expect(sameInput(Option.some({ a: 1 }), Option.some({ a: 1, b: undefined }))).toBe(true)
    expect(sameInput(Option.some({ a: 1 }), Option.some({ a: 1, b: null }))).toBe(false)
  })

  test("identity is the JSON rendering, so a live value matches what the file recorded", () => {
    // The disk row went through `JSON.stringify`, which honours `toJSON` — a Date lands as its ISO
    // string. The compare side must see the same rendering, or a byte-identical input re-runs on
    // every resume (the bug this pins: canonicalising the raw value rendered the Date as `{}`).
    expect(sameInput(Option.some({ when: "1970-01-01T00:00:00.000Z" }), Option.some({ when: new Date(0) }))).toBe(true)
    expect(sameInput(Option.some({ when: new Date(0) }), Option.some({ when: new Date(86_400_000) }))).toBe(false)
  })
})
