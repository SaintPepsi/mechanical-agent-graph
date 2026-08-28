export const inputExamples = [
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    prompt: "Reconcile the visions above with discover's recon...",
    visionPaths: ["docs/graph/GH-288/vision-svelte.md", "docs/graph/GH-288/vision-generic.md"],
    discoverPath: "docs/graph/GH-288/discover.md",
    recycleMapPath: "docs/graph/GH-288/recycle-map.md"
  },
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    prompt: "Reconcile the visions above with discover's recon...",
    visionPaths: ["docs/graph/GH-288/vision-generic.md"],
    discoverPath: "docs/graph/GH-288/discover.md",
    recycleMapPath: "docs/graph/GH-288/recycle-map.md",
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
