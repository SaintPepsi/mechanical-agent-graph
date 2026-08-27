import { describe, expect, test } from "bun:test"
import { type WorktreeParts, worktreeContainerFor, worktreeDirFor } from "mag/runtime/work-root"

const CONTAINER_CASES: ReadonlyArray<readonly [string, string]> = [
  ["/home/dev/repo", "/home/dev/repo-worktrees"],
  ["/home/dev/repo/", "/home/dev/repo-worktrees"],
  ["/home/dev/repo///", "/home/dev/repo-worktrees"],
  ["C:\\Users\\Dev\\repo", "C:/Users/Dev/repo-worktrees"],
  ["/repo", "/repo-worktrees"]
]

const DIR_CASES: ReadonlyArray<{ readonly parts: WorktreeParts; readonly expected: string }> = [
  {
    parts: { repoPath: "/home/dev/repo", ticket: "GH-173", runId: "20260820094500-a1b2" },
    expected: "/home/dev/repo-worktrees/GH-173-20260820094500-a1b2"
  },
  {
    parts: { repoPath: "/home/dev/repo/", ticket: "GH-98", runId: "20260101000000-2" },
    expected: "/home/dev/repo-worktrees/GH-98-20260101000000-2"
  },
  {
    parts: { repoPath: "C:\\Users\\Dev\\repo", ticket: "GH-1", runId: "20260101000000" },
    expected: "C:/Users/Dev/repo-worktrees/GH-1-20260101000000"
  },
  {
    parts: { repoPath: "/repo", ticket: "GH-2", runId: "20260101000000" },
    expected: "/repo-worktrees/GH-2-20260101000000"
  }
]

describe("worktreeContainerFor", () => {
  test("sits beside the checkout, one container regardless of a trailing slash or backslashes", () => {
    for (const [repoPath, expected] of CONTAINER_CASES) expect(worktreeContainerFor(repoPath)).toBe(expected)
  })
})

describe("worktreeDirFor", () => {
  test("composes the container with <ticket>-<runId>", () => {
    for (const useCase of DIR_CASES) expect(worktreeDirFor(useCase.parts)).toBe(useCase.expected)
  })

  test("no composed path carries a backslash, whatever the inputs did", () => {
    const path = worktreeDirFor({ repoPath: "C:\\Users\\Dev\\repo", ticket: "GH-1", runId: "20260101000000" })
    expect(path).not.toContain("\\")
  })
})
