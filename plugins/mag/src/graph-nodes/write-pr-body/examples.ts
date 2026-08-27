export const inputExamples = [
  { base: "main" },
  { base: "main", agent: "effect-expert", model: "sonnet" }
]

export const successExamples = [
  {
    description: "Strips the NUL byte at the artifact writer.",
    headSha: "e5a9c1d0b3f7a2e4d6c8b0a1f3e5d7c9b1a3e5d7",
    sessions: ["a1b2c3"],
    costUsd: 0.12
  },
  {
    description: "Renames the review verdict's summary field to `description` and retires `ships`.\n\n" +
      "## Contract delta\n\nThe review verdict drops the `ships` field.",
    headSha: "d6c8b0a1f3e5d7c9b1a3e5d7e5a9c1d0b3f7a2e4",
    sessions: ["a1b2c3", "d4e5f6"],
    costUsd: null
  }
]
