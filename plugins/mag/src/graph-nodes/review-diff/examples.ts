export const inputExamples = [
  {
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/repo/.claude/graph/GH-98/run-1/ticket.md",
    base: "main",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7"
  },
  {
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/repo/.claude/graph/GH-98/run-1/ticket.md",
    base: "main",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    // A re-review: the send-back moved the tree, and this pass judges the delta against pass 1's findings.
    priorFindingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-diff-1.md",
    addendum: "Verify the fix against the second NUL case specifically.",
    agent: "effect-expert",
    model: "opus"
  },
  {
    // The adjudicating pass — a build pass disputed the previous verdict instead of
    // committing, and this pass rules on the argument alongside the unchanged diff.
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/repo/.claude/graph/GH-98/run-1/ticket.md",
    base: "main",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    findingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-diff-1.md",
    disputePath: "/home/dev/repo/.claude/graph/GH-98/run-1/dispute-1.md"
  }
]
export const successExamples = [
  {
    findingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-diff-1.md",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7",
    sessions: ["a1b2c3"],
    costUsd: 0.31
  },
  {
    findingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-diff-2.md",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
