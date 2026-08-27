import { describe, expect, test } from "bun:test"
import { dirtyPaths } from "mag/runtime/porcelain"

describe("dirtyPaths", () => {
  test.each([
    ["an empty string", "", []],
    ["a clean tree's empty stdout (a single trailing newline)", "\n", []],
    ["a modified tracked file", " M src/foo.ts\n", ["src/foo.ts"]],
    ["an untracked file", "?? src/bar.ts\n", ["src/bar.ts"]],
    ["an untracked directory", "?? sub/\n", ["sub/"]],
    ["a renamed path", "R  old.txt -> new.txt\n", ["old.txt -> new.txt"]],
    ["multiple lines with no trailing newline", " M a.ts\n?? b.ts", ["a.ts", "b.ts"]]
  ])("%s", (_label, stdout, expected) => {
    expect(dirtyPaths(stdout)).toStrictEqual(expected)
  })
})
