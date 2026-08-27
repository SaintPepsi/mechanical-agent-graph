import { describe, expect, test } from "bun:test"
import { escapeQuoted } from "mag/runtime/escape"

const rows: ReadonlyArray<{ readonly name: string; readonly input: string; readonly expected: string }> = [
  { name: "plain ASCII", input: "hello", expected: '"hello"' },
  { name: "embedded double quotes", input: 'say "hi"', expected: '"say \\"hi\\""' },
  { name: "backslashes", input: "C:\\path", expected: '"C:\\\\path"' },
  { name: "non-ASCII passes through verbatim", input: "café — ✅", expected: '"café — ✅"' },
  { name: "a literal tab becomes a \\uXXXX escape, never a raw control byte", input: "a\tb", expected: '"a\\u0009b"' },
]

describe("escapeQuoted", () => {
  for (const { name, input, expected } of rows) {
    test(name, () => {
      expect(escapeQuoted(input)).toBe(expected)
    })
  }

  test("round-trip: JSON.parse(escapeQuoted(input)) recovers the original input, for every row", () => {
    for (const { input } of rows) {
      expect(JSON.parse(escapeQuoted(input))).toBe(input)
    }
  })

  test("emitted-source round-trip: the escaped literal parses as TypeScript source, for every row", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    for (const { input } of rows) {
      expect(() => transpiler.transformSync(`const x = ${escapeQuoted(input)}`)).not.toThrow()
    }
  })
})
