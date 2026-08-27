const PLAN = [
  {
    name: "reset(key) leaves another key's count unchanged",
    behaviour: "after check(\"a\"), check(\"b\"), reset(\"a\"): count(\"b\") is 1",
    bugItCatches: "reset clears the whole map",
    negativeSpace: ["a second reset(\"a\") is safe"]
  }
]

export const inputExamples = [
  { plan: PLAN, testPaths: ["src/limiter.test.ts"], headSha: "ccc333" },
  {
    plan: PLAN,
    testPaths: ["src/limiter.test.ts"],
    headSha: "ddd444",
    resume: "a1b2c3",
    addendum: "Still red at ddd444: src/limiter.test.ts. Make it pass.",
    agent: "effect-expert",
    model: "sonnet"
  }
]

export const successExamples = [
  { headSha: "ddd444", commits: 1, sessions: ["a1b2c3"], costUsd: 0.5, sessionRef: "a1b2c3" }
]
