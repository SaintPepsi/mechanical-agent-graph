import { describe, expect, test } from "bun:test"
import { conflictPaths } from "mag/graph-nodes/detect-conflicts/conflict-paths"

/** Builds a NUL-joined field list ending in a trailing NUL, matching the real probe's own shape. */
const nulJoined = (fields: readonly string[]): string => `${fields.join("\0")}\0`

describe("conflictPaths", () => {
  test("a single-file conflict (probed, git 2.53.0): the oid, one path, the closing empty field, then messages", () => {
    const stdout = nulJoined([
      "19fa8082a974fee83ab37a693a913f24f5bd6113",
      "f.txt",
      "",
      "1",
      "f.txt",
      "Auto-merging",
      "Auto-merging f.txt\n",
      "1",
      "f.txt",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in f.txt\n"
    ])
    expect(conflictPaths(stdout)).toStrictEqual(["f.txt"])
  })

  test("a two-file conflict (probed): both paths precede the same closing empty field", () => {
    const stdout = nulJoined([
      "04e04b24c4758c79066c404395a4875f84be262d",
      "a.txt",
      "b.txt",
      "",
      "1",
      "a.txt",
      "Auto-merging",
      "Auto-merging a.txt\n",
      "1",
      "a.txt",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in a.txt\n",
      "1",
      "b.txt",
      "Auto-merging",
      "Auto-merging b.txt\n",
      "1",
      "b.txt",
      "CONFLICT (contents)",
      "CONFLICT (content): Merge conflict in b.txt\n"
    ])
    expect(conflictPaths(stdout)).toStrictEqual(["a.txt", "b.txt"])
  })

  test("the clean exit's own stdout (probed: the write-tree oid only, no path list) parses to zero paths", () => {
    const stdout = nulJoined(["78c09483cd6f49337c9ef02432534107e9e02a20"])
    expect(conflictPaths(stdout)).toStrictEqual([])
  })

  test("empty stdout parses to zero paths — detect-conflicts reads this as ConflictProbeFailed, not clean", () => {
    expect(conflictPaths("")).toStrictEqual([])
  })

  test("a path containing a space is kept whole, not split on it", () => {
    const stdout = nulJoined(["oid", "src/a file.ts", "", "1", "src/a file.ts"])
    expect(conflictPaths(stdout)).toStrictEqual(["src/a file.ts"])
  })

  test("a path containing a newline is kept whole — the reason -z is used at all", () => {
    const stdout = nulJoined(["oid", "src/weird\nname.ts", "", "1", "src/weird\nname.ts"])
    expect(conflictPaths(stdout)).toStrictEqual(["src/weird\nname.ts"])
  })
})
