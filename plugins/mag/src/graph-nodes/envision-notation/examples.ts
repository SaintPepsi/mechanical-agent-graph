export const inputExamples = [
  {
    notation: "svelte",
    ticket: "GH-288",
    title: "Envision and build the design graph",
    body: "## Executive Summary\n\nOne node per notation, dispatched, checked and committed alone."
  },
  {
    notation: "generic",
    ticket: "GH-288",
    title: "Envision and build the design graph",
    body: "## Executive Summary\n\nOne node per notation, dispatched, checked and committed alone.",
    agent: "effect-expert",
    model: "opus"
  }
]

export const successExamples = [
  {
    notation: "svelte",
    module: "envision-svelte",
    visionPath: "/home/dev/repo/docs/graph/GH-288/vision-svelte.md",
    sessions: ["a1b2c3"],
    costUsd: 0.12
  },
  {
    notation: "generic",
    module: "envision-generic",
    visionPath: "/home/dev/repo/docs/graph/GH-288/vision-generic.md",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
