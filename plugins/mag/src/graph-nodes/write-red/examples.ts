const PLAN = [
  {
    name: "reset(key) leaves another key's count unchanged",
    behaviour: "after check(\"a\"), check(\"b\"), reset(\"a\"): count(\"b\") is 1",
    bugItCatches: "reset clears the whole map",
    negativeSpace: ["a second reset(\"a\") is safe"]
  }
]

export const inputExamples = [
  { plan: PLAN, headSha: "aaa111" },
  {
    plan: PLAN,
    headSha: "bbb222",
    addendum: "The previous attempt's src/limiter.test.ts was already green at bbb222: it asserts nothing the current code gets wrong.",
    agent: "effect-expert",
    model: "sonnet"
  }
]

export const successExamples = [
  {
    testPaths: ["src/limiter.test.ts"],
    stubPaths: ["src/limiter.ts"],
    redSha: "ccc333",
    sessions: ["a1b2c3"],
    costUsd: 0.35,
    sessionRef: "a1b2c3"
  }
]
