export const inputExamples = [
  { base: "main", target: "feat/gh-184-fix", command: "bun run typecheck && bun run test" },
  {
    base: "main",
    target: "feat/gh-184-fix",
    command: "bun run typecheck && bun run test",
    agent: "merge-conflict-resolver",
    model: "opus"
  }
]

export const successExamples = [
  {
    base: "main",
    target: "feat/gh-184-fix",
    conflicts: [],
    resolved: false,
    headSha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    sessions: [],
    costUsd: 0
  },
  {
    base: "main",
    target: "feat/gh-184-fix",
    conflicts: ["src/foo.ts"],
    resolved: true,
    headSha: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    sessions: ["a1b2c3"],
    costUsd: 0.42
  }
]
