import { describe, expect, test } from "bun:test"
import { traceLines, nonEmptyLines, stripTraceLines } from "./stderr"

/**
 * `stderr.ts` is pure plumbing: one shared place for every stderr assertion in
 * this suite to strip GraphNode lifecycle-tracing `mag: `-prefixed lines through, instead of each
 * test file carrying its own copy. These cases pin the filtering itself, on hand-written strings —
 * the end-to-end proof that real node runs emit the lines being stripped lives in `tracing.test.ts`.
 */

describe("stripTraceLines", () => {
  test("removes every line beginning `mag: `, leaving everything else byte-identical", () => {
    const input = "mag: [a] entered\nkeep this line\nmag: [a] exited\nand this one"
    expect(stripTraceLines(input)).toBe("keep this line\nand this one")
  })

  test("the trailing newline survives when there is nothing to strip", () => {
    expect(stripTraceLines("X\n")).toBe("X\n")
  })

  test("the trailing newline survives when a mag: line is stripped", () => {
    expect(stripTraceLines("mag: [a] entered\nX\n")).toBe("X\n")
  })

  test("text containing no mag: line is returned unchanged", () => {
    const input = "just some ordinary stderr output\nwith multiple lines\n"
    expect(stripTraceLines(input)).toBe(input)
  })

  test("a line merely containing mag: mid-line is not removed — only the fixed prefix counts", () => {
    const input = "this line mentions mag: mid-line, not as a prefix"
    expect(stripTraceLines(input)).toBe(input)
  })
})

describe("traceLines", () => {
  test("is stripTraceLines's exact complement: together they partition the input's lines, nothing lost, nothing shared", () => {
    const text = "mag: [a] entered\nkeep me\nmag: [a] exited\nalso keep\n"
    const original = text.split("\n")
    const kept = stripTraceLines(text).split("\n")
    const trace = traceLines(text)

    // Nothing lost: every original line ends up in exactly one of the two outputs.
    expect(kept.length + trace.length).toBe(original.length)

    // Nothing shared: a kept line never carries the mag: prefix, a trace line always does.
    for (const line of kept) {
      expect(line.startsWith("mag: ")).toBe(false)
    }
    for (const line of trace) {
      expect(line.startsWith("mag: ")).toBe(true)
    }

    // Together, as a multiset, they reproduce every original line.
    expect([...kept, ...trace].sort()).toEqual([...original].sort())
  })

  test("returns only the mag: -prefixed lines, in order", () => {
    const text = "mag: first\nnot a trace line\nmag: second\n"
    expect(traceLines(text)).toEqual(["mag: first", "mag: second"])
  })

  test("returns an empty array when the text carries no mag: line", () => {
    expect(traceLines("nothing to see here\n")).toEqual([])
  })
})

describe("nonEmptyLines", () => {
  test("drops empty lines produced by leading/trailing/consecutive newlines", () => {
    expect(nonEmptyLines("\na\n\nb\n\n")).toEqual(["a", "b"])
  })

  test("returns an empty array for an all-blank string", () => {
    expect(nonEmptyLines("")).toEqual([])
    expect(nonEmptyLines("\n\n\n")).toEqual([])
  })

  test("returns a single-element array for a single line with no trailing newline", () => {
    expect(nonEmptyLines("just one line")).toEqual(["just one line"])
  })
})
