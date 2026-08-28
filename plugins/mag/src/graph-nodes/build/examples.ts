export const inputExamples = [
  {
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/repo/.claude/graph/GH-98/run-1/ticket.md",
    branch: "fix/gh-98-nul-byte"
  },
  {
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/repo/.claude/graph/GH-98/run-1/ticket.md",
    branch: "fix/gh-98-nul-byte",
    addendum: "Address every reviewer finding below, then commit:\n- the fix misses the second NUL at line 105",
    agent: "effect-expert",
    model: "sonnet"
  },
  {
    // A send-back pass: `build-under-review` wires `findingsPath` from the review verdict, with no
    // `addendum` alongside it.
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/repo/.claude/graph/GH-98/run-1/ticket.md",
    branch: "fix/gh-98-nul-byte",
    findingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-diff-1.md"
  },
  {
    // A resumed repair, dispatched by the loop against a red suite's own report. The ticket
    // reference and branch are here only because the schema keeps them required; the resumed
    // prompt drops them, the session it resumes already holding them.
    ticket: "GH-98",
    title: "NUL bytes in a ticket body abort the run",
    ticketPath: "/home/dev/repo/.claude/graph/GH-98/run-1/ticket.md",
    branch: "fix/gh-98-nul-byte",
    resume: "a1b2c3",
    addendum: "Verification failed on this pass's head. Read the report at\n/home/dev/repo/.claude/graph/GH-98/run-1/verification-1.txt and fix what it names."
  }
]
export const successExamples = [
  { summaryPath: "/home/dev/repo/.claude/graph/GH-98/run-1/build-1.md", sessions: ["a1b2c3"], costUsd: 0.42, commits: 1, headSha: "aaa111", sessionRef: "a1b2c3" },
  { summaryPath: "/home/dev/repo/.claude/graph/GH-98/run-1/build-2.md", sessions: ["a1b2c3", "d4e5f6"], costUsd: null, commits: 2, headSha: "bbb222", sessionRef: "a1b2c3" },
  {
    // A send-back pass that committed fixes and disputed a finding, on an ordinary success.
    summaryPath: "/home/dev/repo/.claude/graph/GH-98/run-1/build-2.md",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: 0.61,
    commits: 1,
    headSha: "ccc333",
    sessionRef: "a1b2c3",
    findingsPath: "/home/dev/repo/.claude/graph/GH-98/run-1/review-diff-1.md",
    disputePath: "/home/dev/repo/.claude/graph/GH-98/run-1/dispute-1.md"
  }
]
