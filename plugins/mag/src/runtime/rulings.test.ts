import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import type { GitFailureFields } from "mag/runtime/git"
import { declaredRulings, nulPaths, PRINCIPLES_PATHSPEC, RULINGS_PATHSPEC, rulingsBlock } from "mag/runtime/rulings"
import { shellLayer } from "mag/runtime/shell"
import { scriptedShell } from "mag/test/node-fixture"

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

/** The caller's own error, the shape every node's `*GitFailed` carries. */
class FixtureGitFailed {
  readonly _tag = "FIXTURE_GIT_FAILED"
  constructor(readonly fields: GitFailureFields) {}
}

const read = (stdout: string, exitCode = 0) => {
  const shell = scriptedShell([{ exitCode, stdout, stderr: exitCode === 0 ? "" : "fatal: bad object\n" }])
  const result = Effect.runSync(
    Effect.result(declaredRulings("/repo", (fields) => new FixtureGitFailed(fields)).pipe(Effect.provide(shellLayer(shell.service))))
  )
  return { ...shell, result }
}

describe("declaredRulings", () => {
  test("runs one ls-files over the rulings pathspec in the given cwd and returns the NUL-split paths", () => {
    const { calls, cwds, result } = read("CLAUDE.md\0plugins/mag/PRINCIPLES.md\0")
    expect(calls).toStrictEqual([
      ["git", "ls-files", "-z", "--full-name", "--", ":/CLAUDE.md", ":/*/CLAUDE.md", ":/**/CLAUDE.md", ":/PRINCIPLES.md", ":/*/PRINCIPLES.md"]
    ])
    expect(cwds).toStrictEqual(["/repo"])
    expect(Result.isSuccess(result) && result.success).toStrictEqual(["CLAUDE.md", "plugins/mag/PRINCIPLES.md"])
  })

  test("a repository with no rulings files yields an empty list, not a failure", () => {
    const { result } = read("")
    expect(Result.isSuccess(result) && result.success).toStrictEqual([])
  })

  test("a non-zero exit fails the caller's own error, argv and stderr aboard", () => {
    const { result } = read("", 128)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(FixtureGitFailed)
    if (!(result.failure instanceof FixtureGitFailed)) return
    expect(result.failure.fields).toStrictEqual({ argv: expect.stringContaining("git ls-files -z --full-name -- :/CLAUDE.md"), exitCode: 128, stderr: "fatal: bad object" })
  })
})

describe("rulingsBlock", () => {
  test("no rulings files renders nothing, so a prompt never announces an empty list", () => {
    expect(rulingsBlock([])).toStrictEqual([])
  })

  test("lists every file under the one heading, blank line first so it appends cleanly to any block", () => {
    expect(rulingsBlock(["CLAUDE.md", "plugins/mag/PRINCIPLES.md"])).toStrictEqual([
      "",
      "This repository states rulings of its own, in the files below:",
      "- CLAUDE.md",
      "- plugins/mag/PRINCIPLES.md"
    ])
  })
})
