import { describe, expect, test } from "bun:test"
import { nulPaths, PRINCIPLES_PATHSPEC, RULINGS_PATHSPEC } from "mag/runtime/rulings"

describe("rulings pathspecs", () => {
  test("the rulings pathspec is the CLAUDE.md family plus the principles pathspec, every entry root-anchored and exact-named", () => {
    for (const spec of PRINCIPLES_PATHSPEC) expect(RULINGS_PATHSPEC).toContain(spec)
    expect(RULINGS_PATHSPEC).toContain(":/CLAUDE.md")
    expect(RULINGS_PATHSPEC).toContain(":/**/CLAUDE.md")
    for (const spec of RULINGS_PATHSPEC) {
      expect(spec.startsWith(":/")).toBe(true)
      expect(spec.endsWith("/CLAUDE.md") || spec.endsWith("/PRINCIPLES.md")).toBe(true)
    }
  })

  test("nulPaths splits -z output and drops the trailing empty entry", () => {
    expect(nulPaths("CLAUDE.md\0plugins/mag/PRINCIPLES.md\0")).toStrictEqual(["CLAUDE.md", "plugins/mag/PRINCIPLES.md"])
    expect(nulPaths("")).toStrictEqual([])
  })
})
