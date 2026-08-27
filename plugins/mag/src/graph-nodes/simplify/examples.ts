export const inputExamples = [
  {
    ticket: "GH-246",
    base: "main",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7"
  },
  {
    ticket: "GH-246",
    base: "main",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    agent: "effect-expert",
    model: "opus"
  }
]

export const successExamples = [
  {
    // A reduction landed: the node's own commit moved HEAD.
    simplified: true,
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    sessions: ["a1b2c3"],
    costUsd: 0.12,
    sessionRef: "a1b2c3"
  },
  {
    // The no-op case: a clean tree after the session, HEAD unchanged, no session ran at all in the
    // empty-range case (costUsd 0, not null: unpriced would mean a session ran and wasn't billed).
    // No sessionRef either, nothing ran, so there is nothing to resume.
    simplified: false,
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7",
    sessions: [],
    costUsd: 0
  }
]
