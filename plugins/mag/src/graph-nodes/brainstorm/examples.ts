export const inputExamples = [
  {
    // The design pass: resumes the session envision-shell opened, over the discover note.
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    prompt: "Complete the design around the shell...",
    discoverPath: "docs/graph/GH-288/discover.md",
    resume: "a1b2c3"
  },
  {
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    prompt: "Complete the design around the shell...",
    discoverPath: "docs/graph/GH-288/discover.md",
    resume: "a1b2c3",
    agent: "effect-expert",
    model: "opus"
  },
  {
    // A send-back pass: the same session is resumed over the reviewer's findings.
    ticket: "GH-288",
    title: "Envision and build the design graph",
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/GH-288/run-1/ticket.md",
    prompt: "Complete the design around the shell...",
    discoverPath: "docs/graph/GH-288/discover.md",
    findingsPath: "/home/dev/repo/.claude/graph/GH-288/run-1/review-plan-1.md",
    resume: "a1b2c3"
  }
]

export const successExamples = [
  {
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3"],
    costUsd: 0.42,
    sessionRef: "a1b2c3",
    changed: true
  },
  {
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null,
    sessionRef: "a1b2c3",
    changed: true
  },
  {
    // A send-back pass that disputed a finding: both paths ride the success.
    designPath: "/home/dev/repo/docs/graph/GH-288/design.md",
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    sessions: ["a1b2c3"],
    costUsd: 0.2,
    findingsPath: "/home/dev/repo/.claude/graph/GH-288/run-1/review-plan-1.md",
    disputePath: "/home/dev/repo/.claude/graph/GH-288/run-1/dispute-1.md",
    sessionRef: "a1b2c3",
    changed: false
  }
]
