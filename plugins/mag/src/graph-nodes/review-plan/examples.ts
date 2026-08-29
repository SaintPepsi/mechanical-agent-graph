export const inputExamples = [
  {
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-98/run-1/ticket.md",
    designPath: "/home/dev/repo/docs/graph/GH-98/design.md",
    planPath: "/home/dev/repo/docs/graph/GH-98/plan.md",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7"
  },
  {
    // A re-review: the send-back rewrote the design, and this pass judges the delta against pass 1's findings.
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-98/run-1/ticket.md",
    designPath: "/home/dev/repo/docs/graph/GH-98/design.md",
    planPath: "/home/dev/repo/docs/graph/GH-98/plan.md",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    priorFindingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-plan-1.md"
  },
  {
    // The adjudicating pass: brainstorm disputed the previous verdict, and this pass rules on the
    // argument alongside the design and plan as they stand.
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-98/run-1/ticket.md",
    designPath: "/home/dev/repo/docs/graph/GH-98/design.md",
    planPath: "/home/dev/repo/docs/graph/GH-98/plan.md",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    findingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-plan-1.md",
    disputePath: "/home/dev/repo/.claude/graph/GH-98/run-1/dispute-1.md",
    agent: "effect-expert",
    model: "opus"
  }
]

export const successExamples = [
  {
    findingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-plan-1.md",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7",
    sessions: ["a1b2c3"],
    costUsd: 0.31
  },
  {
    findingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-plan-2.md",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
