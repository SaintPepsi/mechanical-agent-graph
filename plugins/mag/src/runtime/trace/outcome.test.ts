import { describe, expect, test } from "bun:test"
import { Cause, Data, Exit } from "effect"
import { UNTAGGED_FAILURE, outcomeOf } from "./outcome"

class Boom extends Data.TaggedError("BOOM")<{ readonly message: string }> {}

class SomeTagged extends Data.TaggedError("SOME_TAG")<{}> {}

describe("outcomeOf", () => {
  test("Exit.succeed → ok, no tag", () => {
    const result = outcomeOf(Exit.succeed(1))

    expect(result).toEqual({ outcome: "ok" })
    expect("tag" in result).toBe(false)
  })

  test("a Data.TaggedError failure → fail, tag is the error's own _tag", () => {
    const exit = Exit.fail(new Boom({ message: "kaboom" }))

    expect(outcomeOf(exit)).toEqual({ outcome: "fail", tag: "BOOM" })
  })

  test("a plain-object failure with no _tag → fail, tag falls back to UNKNOWN_ERROR", () => {
    const exit = Exit.fail({ message: "no tag here" })

    expect(outcomeOf(exit)).toEqual({ outcome: "fail", tag: UNTAGGED_FAILURE })
  })

  test("a failure whose _tag is not a string (a number) → tag falls back to UNKNOWN_ERROR", () => {
    const exit = Exit.fail({ _tag: 404 })

    expect(outcomeOf(exit)).toEqual({ outcome: "fail", tag: UNTAGGED_FAILURE })
  })

  test("Exit.die(taggedDefect) → die, tag is the defect's own _tag", () => {
    const exit = Exit.die(new SomeTagged())

    expect(outcomeOf(exit)).toEqual({ outcome: "die", tag: "SOME_TAG" })
  })

  test("Exit.die(new Error(...)) → die, tag falls back to UNKNOWN_ERROR", () => {
    const exit = Exit.die(new Error("raw"))

    expect(outcomeOf(exit)).toEqual({ outcome: "die", tag: UNTAGGED_FAILURE })
  })

  test("an interrupted exit → interrupt, no tag field at all", () => {
    const exit = Exit.interrupt()

    const result = outcomeOf(exit)

    expect(result).toEqual({ outcome: "interrupt" })
    expect("tag" in result).toBe(false)
  })

  test("a cause carrying both a failure and an interrupt → fail wins (documented precedence)", () => {
    const combined = Cause.combine(Cause.fail(new Boom({ message: "kaboom" })), Cause.interrupt())
    const exit = Exit.failCause(combined)

    expect(outcomeOf(exit)).toEqual({ outcome: "fail", tag: "BOOM" })
  })
})
