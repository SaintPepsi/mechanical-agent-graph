export const inputExamples = [
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    notations: ["svelte", "effect"]
  },
  {
    // No stack matched: the generic notation draws the shell.
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    notations: [],
    agent: "effect-expert",
    model: "opus"
  }
]

export const successExamples = [
  {
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    modules: ["envision-svelte", "envision-effect"],
    sessionRef: "a1b2c3",
    sessions: ["a1b2c3"],
    costUsd: 0.12
  },
  {
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    modules: ["envision-generic"],
    sessionRef: "a1b2c3",
    sessions: ["a1b2c3"],
    costUsd: null
  }
]
