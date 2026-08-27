export const inputExamples = [
  {
    notations: ["svelte", "generic"],
    ticket: "GH-288",
    title: "Envision and build the design graph",
    body: "## Executive Summary\n\nOne node per notation, dispatched, checked and committed alone."
  },
  {
    notations: ["generic"],
    ticket: "GH-288",
    title: "Envision and build the design graph",
    body: "## Executive Summary\n\nOne node per notation, dispatched, checked and committed alone.",
    agent: "effect-expert",
    model: "opus"
  }
]

export const successExamples = [
  {
    visions: [
      { notation: "svelte", visionPath: "/home/dev/repo/docs/graph/GH-288/vision-svelte.md" },
      { notation: "generic", visionPath: "/home/dev/repo/docs/graph/GH-288/vision-generic.md" }
    ],
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: 0.24
  },
  {
    visions: [{ notation: "generic", visionPath: "/home/dev/repo/docs/graph/GH-288/vision-generic.md" }],
    sessions: ["a1b2c3"],
    costUsd: null
  }
]
