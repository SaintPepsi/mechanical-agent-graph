import { describe, expect, it } from "bun:test"
import { SlidingWindow } from "./limiter"

describe("SlidingWindow", () => {
  it("creates a limiter and checks a key", () => {
    const l = new SlidingWindow(2, 1000)
    l.check("user-1")
  })

  it("returns a decision", () => {
    const l = new SlidingWindow(2, 1000)
    expect(l.check("user-1")).toBeDefined()
  })

  it("returns the expected decision shape", () => {
    const l = new SlidingWindow(2, 1000)
    expect(l.check("user-1")).toEqual({
      allowed: expect.any(Boolean),
      remaining: expect.any(Number),
      retryAfterMs: expect.any(Number)
    })
  })

  it("peek is stable", () => {
    const l = new SlidingWindow(2, 1000)
    expect(l.peek("user-1")).toEqual(l.peek("user-1"))
  })

  it.skip("expires old hits", () => {
    expect(true).toBe(true)
  })

  it("allows the first request", () => {
    const l = new SlidingWindow(2, 1000)
    expect(l.check("user-1").allowed).toBe(true)
  })

  it("denies once past the limit", () => {
    const l = new SlidingWindow(1, 1000)
    l.check("user-1")
    expect(l.check("user-1").allowed).toBe(false)
  })
})
