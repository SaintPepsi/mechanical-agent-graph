export const inputExamples = [
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    body: "## Executive Summary\n\nOne node per notation, dispatched, checked and committed alone.",
    prompt: "Reconcile the visions above with discover's recon...",
    visionPaths: ["docs/graph/GH-288/vision-svelte.md", "docs/graph/GH-288/vision-generic.md"],
    discoverPath: "docs/graph/GH-288/discover.md"
  },
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    body: "## Executive Summary\n\nOne node per notation, dispatched, checked and committed alone.",
    prompt: "Reconcile the visions above with discover's recon...",
    visionPaths: ["docs/graph/GH-288/vision-generic.md"],
    discoverPath: "docs/graph/GH-288/discover.md",
    agent: "effect-expert",
    model: "opus"
  }
]

export const successExamples = [
  {
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3"],
    costUsd: 0.42
  },
  {
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
