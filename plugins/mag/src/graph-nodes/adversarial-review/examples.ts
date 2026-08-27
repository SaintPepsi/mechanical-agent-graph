export const inputExamples = [
  {
    srcPaths: ["src/limiter.ts"],
    testPaths: ["src/limiter.test.ts"],
    command: "bun run typecheck && bun run test",
    breakers: 3,
    budget: 3
  },
  {
    srcPaths: ["src/limiter.ts"],
    testPaths: ["tests/test_limiter.py"],
    command: "pytest",
    breakers: 1,
    budget: 5,
    agent: "effect-expert",
    breakModel: "sonnet",
    judgeModel: "haiku"
  }
]

export const successExamples = [
  { rated: [], smells: [], claims: 4, sessions: ["break-1", "break-2"], costUsd: 0.8 },
  {
    rated: [
      {
        path: "src/limiter.ts",
        find: "this.hits.delete(key)",
        replace: "this.hits.clear()",
        probeSource: "bun -e 'console.log(1)'",
        category: "isolation",
        severity: 3
      }
    ],
    smells: [
      {
        path: "src/limiter.test.ts",
        severity: "warn",
        rule: "weak-assertion-only",
        line: 12,
        message: "\"resets\" only asserts toBeDefined: that passes for `{}`, `\"x\"`, and most wrong answers. Assert the value you expect."
      }
    ],
    claims: 4,
    sessions: ["break-1", "break-2", "judge-1"],
    costUsd: 0.82
  }
]
