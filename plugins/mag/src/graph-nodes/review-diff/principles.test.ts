import { describe, expect, test } from "bun:test"
import { governingPrinciples, nulPaths } from "mag/graph-nodes/review-diff/principles"

describe("nulPaths", () => {
  test("splits on NUL and drops the trailing empty the terminating NUL produces", () => {
    expect(nulPaths("a.ts\0b.ts\0")).toStrictEqual(["a.ts", "b.ts"])
  })

  test("empty stdout yields no paths", () => {
    expect(nulPaths("")).toStrictEqual([])
  })

  test("a path with a space passes through untouched", () => {
    expect(nulPaths("dir with space/z.ts\0")).toStrictEqual(["dir with space/z.ts"])
  })
})

describe("governingPrinciples", () => {
  test("a root file governs every changed path, including one at the root", () => {
    expect(governingPrinciples(["x.ts", "pkg/a/y.ts"], ["PRINCIPLES.md"])).toStrictEqual(["PRINCIPLES.md"])
  })

  test("a package file governs its own subtree and not a sibling package's", () => {
    const declared = ["pkg/a/PRINCIPLES.md"]
    expect(governingPrinciples(["pkg/a/x.ts"], declared)).toStrictEqual(declared)
    expect(governingPrinciples(["pkg/b/y.ts"], declared)).toStrictEqual([])
  })

  test("the trailing-slash boundary: dir/PRINCIPLES.md does not govern dir-other/x.ts", () => {
    expect(governingPrinciples(["dir-other/x.ts"], ["dir/PRINCIPLES.md"])).toStrictEqual([])
  })

  test("a path with a space in a directory name still intersects correctly", () => {
    const declared = ["dir with space/PRINCIPLES.md"]
    expect(governingPrinciples(["dir with space/z.ts"], declared)).toStrictEqual(declared)
  })

  test("a diff that edits a principles file makes it govern itself", () => {
    expect(governingPrinciples(["PRINCIPLES.md"], ["PRINCIPLES.md"])).toStrictEqual(["PRINCIPLES.md"])
  })

  test("no changed paths yields an empty list", () => {
    expect(governingPrinciples([], ["PRINCIPLES.md"])).toStrictEqual([])
  })

  test("no declared files yields an empty list", () => {
    expect(governingPrinciples(["x.ts"], [])).toStrictEqual([])
  })

  test("a deep nested file governs its own subtree", () => {
    const declared = ["pkg/a/sub/deep/PRINCIPLES.md"]
    expect(governingPrinciples(["pkg/a/sub/deep/x.ts"], declared)).toStrictEqual(declared)
    expect(governingPrinciples(["pkg/a/x.ts"], declared)).toStrictEqual([])
  })

  test("a monorepo diff surfaces both a package file and a root file, in declared order", () => {
    const declared = ["PRINCIPLES.md", "pkg/a/PRINCIPLES.md", "pkg/b/PRINCIPLES.md"]
    expect(governingPrinciples(["pkg/a/x.ts"], declared)).toStrictEqual(["PRINCIPLES.md", "pkg/a/PRINCIPLES.md"])
  })

  /**
   * A rename's source path: default rename detection drops it from
   * `--name-only`, so `graph-node.ts` reads `changed` with `--no-renames` and both names of
   * `git mv pkg/a/x.ts pkg/b/x.ts` land in this array. A principles file governing only the
   * source directory must still see the diff as touching it, even though the file no longer lives
   * there after the rename.
   */
  test("a rename's source-side path still governs, when the diff read carries both names", () => {
    const declared = ["pkg/a/PRINCIPLES.md"]
    expect(governingPrinciples(["pkg/a/x.ts", "pkg/b/x.ts"], declared)).toStrictEqual(declared)
  })
})
