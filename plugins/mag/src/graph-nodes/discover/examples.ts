export const inputExamples = [
  {
    ticket: "GH-258",
    title: "Discover: independent mechanical recon of what exists",
    body: "## Executive Summary\n\nDiscover answers what currently exists in the repo a ticket touches."
  },
  {
    ticket: "GH-258",
    title: "Discover: independent mechanical recon of what exists",
    body: "## Executive Summary\n\nDiscover answers what currently exists in the repo a ticket touches.",
    agent: "effect-expert",
    model: "opus"
  }
]

export const successExamples = [
  {
    discoverPath: "/home/dev/repo/docs/graph/GH-258/discover.md",
    sessions: ["a1b2c3"],
    costUsd: 0.18
  },
  {
    discoverPath: "/home/dev/repo/docs/graph/GH-258/discover.md",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
