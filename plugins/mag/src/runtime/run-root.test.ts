import { describe, expect, test } from "bun:test"
import {
  configDir,
  type Env,
  graphRoot,
  isSafeSegment,
  journalPathFor,
  projectDirFor,
  projectKey,
  runDirFor,
  ticketDirFor,
  transcriptsRoot
} from "mag/runtime/run-root"

/**
 * The parity table. Every `expected` below is a captured constant, not a computed one — pinned
 * once so a change to the composers below can't silently drift from a path a caller already
 * depends on. Preimages are neutral (a fake POSIX home, a fake Windows checkout, a fake deep
 * nested checkout) — none is a real machine path — and each row's expected value is the capture
 * for that exact neutral preimage.
 *
 * `repoPath` may be `null`/`undefined` upstream and coerces via `String(repoPath ?? "")`. Those
 * two inputs are unreachable through this function's typed signature, and coerce to the same
 * empty-string path anyway — the `""` row below covers it.
 */

const ROOT_CASES: ReadonlyArray<{
  readonly env: Env
  readonly home: string
  readonly configDir: string
  readonly graphRoot: string
  readonly transcriptsRoot: string
}> = [
  {
    env: {},
    home: "/home/dev",
    configDir: "/home/dev/.claude",
    graphRoot: "/home/dev/.claude/graph",
    transcriptsRoot: "/home/dev/.claude/projects"
  },
  { env: {}, home: "", configDir: "/.claude", graphRoot: "/.claude/graph", transcriptsRoot: "/.claude/projects" },
  {
    env: { CLAUDE_CONFIG_DIR: "/opt/cfg" },
    home: "/home/dev",
    configDir: "/opt/cfg",
    graphRoot: "/opt/cfg/graph",
    transcriptsRoot: "/opt/cfg/projects"
  },
  {
    env: { CLAUDE_CONFIG_DIR: "C:\\Users\\Dev\\.claude" },
    home: "/home/dev",
    configDir: "C:/Users/Dev/.claude",
    graphRoot: "C:/Users/Dev/.claude/graph",
    transcriptsRoot: "C:/Users/Dev/.claude/projects"
  },
  {
    env: { CLAUDE_CONFIG_DIR: "" },
    home: "/home/dev",
    configDir: "/home/dev/.claude",
    graphRoot: "/home/dev/.claude/graph",
    transcriptsRoot: "/home/dev/.claude/projects"
  }
]

const KEY_CASES: ReadonlyArray<readonly [string, string]> = [
  ["/srv/checkouts/mechanical-agent-graph", "mechanical-agent-graph-11e8712a"],
  ["/home/dev/repo/", "repo-ae0d5dd9"],
  ["/home/dev/repo///", "repo-ae0d5dd9"],
  ["C:\\Users\\Dev\\Documents\\repo", "repo-f758ee1f"],
  ["/home/dev/my repo!", "my-repo--b9e75a62"],
  ["/", "repo-e3b0c442"],
  ["", "repo-e3b0c442"],
  ["/home/dev/.dotted", ".dotted-fca03882"],
  ["/home/dev/UPPER_Case-1.2", "UPPER_Case-1.2-9e042f71"]
]

const COMPOSED_CASES = [
  {
    parts: { env: {}, home: "/home/dev", repoPath: "/home/dev/repo", ticket: "GH-120", runId: "20260818123000" },
    projectDir: "/home/dev/.claude/graph/repo-ae0d5dd9",
    ticketDir: "/home/dev/.claude/graph/repo-ae0d5dd9/GH-120",
    runDir: "/home/dev/.claude/graph/repo-ae0d5dd9/GH-120/20260818123000"
  },
  {
    parts: {
      env: { CLAUDE_CONFIG_DIR: "C:\\cfg" },
      home: "",
      repoPath: "C:\\Users\\Dev\\repo",
      ticket: "GH-98",
      runId: "20260101000000-2"
    },
    projectDir: "C:/cfg/graph/repo-682a498f",
    ticketDir: "C:/cfg/graph/repo-682a498f/GH-98",
    runDir: "C:/cfg/graph/repo-682a498f/GH-98/20260101000000-2"
  }
] as const

describe("run-root", () => {
  test("configDir, graphRoot and transcriptsRoot match the recorded reference values", () => {
    for (const useCase of ROOT_CASES) {
      expect(configDir(useCase.env, useCase.home)).toBe(useCase.configDir)
      expect(graphRoot(useCase.env, useCase.home)).toBe(useCase.graphRoot)
      expect(transcriptsRoot(useCase.env, useCase.home)).toBe(useCase.transcriptsRoot)
    }
  })

  test("projectKey matches the recorded reference values", () => {
    for (const [repoPath, expected] of KEY_CASES) expect(projectKey(repoPath)).toBe(expected)
  })

  test("the composed directories match the recorded reference values", () => {
    for (const useCase of COMPOSED_CASES) {
      expect(projectDirFor(useCase.parts)).toBe(useCase.projectDir)
      expect(ticketDirFor(useCase.parts)).toBe(useCase.ticketDir)
      expect(runDirFor(useCase.parts)).toBe(useCase.runDir)
    }
  })

  test("a run's journal sits directly in the run directory", () => {
    for (const useCase of COMPOSED_CASES) {
      expect(journalPathFor(useCase.parts)).toBe(`${useCase.runDir}/journal.jsonl`)
    }
  })

  test("no composed path carries a backslash, whatever the inputs did", () => {
    const runDir = runDirFor({
      env: { CLAUDE_CONFIG_DIR: "C:\\cfg\\sub" },
      home: "C:\\home",
      repoPath: "C:\\Users\\Dev\\repo",
      ticket: "GH-1",
      runId: "20260101000000"
    })
    expect(runDir).not.toContain("\\")
  })
})

describe("isSafeSegment", () => {
  test("ordinary ticket and run ids pass", () => {
    for (const value of ["GH-98", "PROJ-42", "20260818142233-a1b2", "a.b_c-d"]) {
      expect(isSafeSegment(value)).toBe(true)
    }
  })

  test("empty, dot-hops, separators and NUL are rejected", () => {
    for (const value of ["", ".", "..", "GH-98/evil", "..\\up", "a\\b", "nul\0byte", "../../etc"]) {
      expect(isSafeSegment(value)).toBe(false)
    }
  })
})
