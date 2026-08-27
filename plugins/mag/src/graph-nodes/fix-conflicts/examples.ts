export const inputExamples = [
  {
    base: "main",
    target: "feat/gh-184-fix",
    baseSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    targetSha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3"
  },
  {
    base: "main",
    target: "feat/gh-184-fix",
    baseSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    targetSha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    agent: "merge-conflict-resolver",
    model: "opus"
  }
]

export const successExamples = [
  {
    paths: ["src/foo.ts"],
    treeSha: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    summaryPath: "/home/dev/repo/.claude/graph/GH-184/run-1/fix-conflicts-1.md",
    sessions: ["a1b2c3"],
    costUsd: 0.42
  },
  {
    paths: ["src/foo.ts", "src/bar.ts"],
    treeSha: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
    summaryPath: "/home/dev/repo/.claude/graph/GH-184/run-1/fix-conflicts-2.md",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
