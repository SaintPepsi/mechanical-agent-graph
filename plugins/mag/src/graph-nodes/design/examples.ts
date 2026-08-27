export const inputExamples = [
  {
    ticket: "GH-152",
    title: "A design step before build for graph work",
    body: "## Executive Summary\n\nA new graph for tickets whose target is the graph itself."
  },
  {
    ticket: "GH-152",
    title: "A design step before build for graph work",
    body: "## Executive Summary\n\nA new graph for tickets whose target is the graph itself.",
    agent: "effect-expert",
    model: "opus"
  }
]
export const successExamples = [
  {
    designPath: "/home/dev/repo/docs/graph/GH-152/design.md",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7",
    sessions: ["a1b2c3"],
    costUsd: 0.31
  },
  {
    designPath: "/home/dev/repo/docs/graph/GH-152/design.md",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
