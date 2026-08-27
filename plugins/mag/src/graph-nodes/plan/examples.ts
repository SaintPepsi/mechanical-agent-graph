export const inputExamples = [
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    body: "## Executive Summary\n\nOne node per notation, dispatched, checked and committed alone.",
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    discoverPath: "/home/dev/repo/docs/graph/GH-288/discover.md"
  },
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    body: "## Executive Summary\n\nOne node per notation, dispatched, checked and committed alone.",
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    discoverPath: "/home/dev/repo/docs/graph/GH-288/discover.md",
    agent: "effect-expert",
    model: "opus"
  }
]

export const successExamples = [
  {
    planPath: "/home/dev/repo/docs/graph/GH-288/plan.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3"],
    costUsd: 0.42
  },
  {
    planPath: "/home/dev/repo/docs/graph/GH-288/plan.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
