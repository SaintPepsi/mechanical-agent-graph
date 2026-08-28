export const inputExamples = [
  {
    ticket: "GH-98",
    title: "Fix the NUL-byte crash",
    ticketPath: "/repo/.claude/graph/run-1/ticket.md",
    branch: "feat/GH-98-fix-the-nul-byte-crash",
    command: "bun run typecheck && bun run test",
    base: "main",
    cap: 2,
    designPath: "docs/graph/GH-98/design.md",
    agent: "effect-expert",
    buildModel: "sonnet",
    simplifyModel: "opus",
    reviewModel: "opus"
  },
  {
    // No design step ran, no agent named — both fields simply absent.
    ticket: "GH-98",
    title: "Fix the NUL-byte crash",
    ticketPath: "/repo/.claude/graph/run-1/ticket.md",
    branch: "feat/GH-98-fix-the-nul-byte-crash",
    command: "bun run typecheck && bun run test",
    base: "main",
    cap: 2
  }
]

export const successExamples = [
  {
    summaryPath: "/repo/.claude/graph/run-1/build-2.md",
    commits: 1,
    reviewPasses: 2,
    headSha: "1111111111111111111111111111111111111111",
    sessions: ["session-build-1", "session-review-1", "session-build-2", "session-review-2"],
    costUsd: 1.2
  },
  {
    // The loop settled on a dispute an adjudicating review pass accepted — `commits`
    // is honestly 0, the last pass's own count, and `disputePath` says how the run ended this way.
    summaryPath: "/repo/.claude/graph/run-1/build-2.md",
    commits: 0,
    reviewPasses: 2,
    headSha: "1111111111111111111111111111111111111111",
    disputePath: "/repo/.claude/graph/run-1/dispute-1.md",
    sessions: ["session-build-1", "session-review-1", "session-build-2", "session-review-2"],
    costUsd: 1.2
  },
  {
    // The loop settled on a *committed* pass's dispute, unlike the zero-commit example above.
    summaryPath: "/repo/.claude/graph/run-1/build-2.md",
    commits: 2,
    reviewPasses: 2,
    headSha: "1111111111111111111111111111111111111111",
    disputePath: "/repo/.claude/graph/run-1/dispute-1.md",
    sessions: ["session-build-1", "session-review-1", "session-build-2", "session-review-2"],
    costUsd: 1.2
  }
]
