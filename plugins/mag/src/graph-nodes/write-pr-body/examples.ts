export const inputExamples = [
  { base: "main" },
  { base: "main", agent: "effect-expert", model: "sonnet" }
]

export const successExamples = [
  {
    descriptionPath: "/home/dev/repo/.claude/graph/GH-98/run-1/pr-description-1.md",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7",
    sessions: ["a1b2c3"],
    costUsd: 0.12
  },
  {
    descriptionPath: "/home/dev/repo/.claude/graph/GH-98/run-1/pr-description-1.md",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
