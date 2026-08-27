export const inputExamples = [
  {
    ticket: "GH-98",
    base: "main",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7"
  },
  {
    ticket: "GH-98",
    base: "main",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    agent: "effect-expert",
    model: "opus"
  }
]
export const successExamples = [
  {
    rewritten: 0,
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7",
    sessions: [],
    costUsd: 0
  },
  {
    rewritten: 2,
    headSha: "bbb2220b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7",
    sessions: ["a1b2c3"],
    costUsd: 0.31
  }
]
