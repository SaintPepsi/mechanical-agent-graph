export const inputExamples = [
  {
    acs: ["**AC.01 - reset(key) clears only that key**", "**AC.02 - a repeated reset is safe**"],
    discoverPath: "docs/graph/GH-98/discover.md"
  },
  { acs: ["- the limiter refuses the sixth hit inside the window"], discoverPath: "docs/graph/GH-98/discover.md", agent: "effect-expert", model: "opus" }
]

export const successExamples = [
  {
    plan: [
      {
        name: "reset(key) leaves another key's count unchanged",
        behaviour: "after check(\"a\"), check(\"b\"), reset(\"a\"): count(\"b\") is 1",
        bugItCatches: "reset clears the whole map",
        negativeSpace: ["a second reset(\"a\") is safe", "the caller's key string is not mutated"]
      }
    ],
    sessions: ["a1b2c3"],
    costUsd: 0.3
  }
]
