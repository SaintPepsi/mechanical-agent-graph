export const inputExamples = [
  {
    acs: ["**AC.01 - reset(key) clears only that key**"],
    discoverPath: "docs/graph/GH-98/discover.md",
    base: "main",
    command: "bun run typecheck && bun run test",
    testCommand: "bun test \"$1\"",
    cap: 2,
    redGreenCap: 2,
    breakers: 3,
    budget: 3
  },
  {
    acs: ["- the limiter refuses the sixth hit inside the window"],
    discoverPath: "docs/graph/GH-98/discover.md",
    base: "main",
    command: "bun run typecheck && bun run test",
    testCommand: "bun test \"$1\"",
    cap: 1,
    redGreenCap: 1,
    breakers: 1,
    budget: 5,
    agent: "effect-expert",
    planModel: "opus",
    writeModel: "sonnet",
    implementModel: "sonnet",
    breakModel: "sonnet",
    judgeModel: "haiku"
  }
]

export const successExamples = [
  {
    headSha: "ccc333",
    summaryPath: "/repo/.claude/graph/run-1/tdd-build-1.md",
    commits: 2,
    testPaths: ["src/limiter.test.ts"],
    rounds: 1,
    escapes: 0,
    sessions: ["plan-1", "red-1", "green-1", "break-1"],
    costUsd: 1.55,
    sessionRef: "green-1"
  }
]
