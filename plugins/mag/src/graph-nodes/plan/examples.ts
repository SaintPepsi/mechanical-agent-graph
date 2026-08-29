export const inputExamples = [
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    recycleScanPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/recycle-scan.md"
  },
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    recycleScanPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/recycle-scan.md",
    agent: "effect-expert",
    model: "opus"
  },
  {
    // A send-back pass: the session that wrote the plan is resumed over the reviewer's plan-tagged findings.
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    recycleScanPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/recycle-scan.md",
    findingsPath: "/home/dev/repo/.claude/graph/GH-288/run-1/review-plan-1.md",
    resume: "a1b2c3"
  }
]

export const successExamples = [
  {
    planPath: "/home/dev/repo/docs/graph/GH-288/plan.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3"],
    costUsd: 0.42,
    sessionRef: "a1b2c3"
  },
  {
    planPath: "/home/dev/repo/docs/graph/GH-288/plan.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null,
    sessionRef: "a1b2c3"
  }
]
