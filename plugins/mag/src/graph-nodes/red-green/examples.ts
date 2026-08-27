const PLAN = [
  {
    name: "reset(key) leaves another key's count unchanged",
    behaviour: "after check(\"a\"), check(\"b\"), reset(\"a\"): count(\"b\") is 1",
    bugItCatches: "reset clears the whole map",
    negativeSpace: ["a second reset(\"a\") is safe"]
  }
]

export const inputExamples = [
  { plan: PLAN, headSha: "aaa111", typecheckCommand: "bun run typecheck", testCommand: "bun test \"$1\"", cap: 2 },
  {
    plan: PLAN,
    headSha: "aaa111",
    typecheckCommand: "bun run typecheck",
    testCommand: "bun test \"$1\"",
    cap: 1,
    agent: "effect-expert",
    writeModel: "sonnet",
    implementModel: "sonnet"
  }
]

export const successExamples = [
  {
    testPaths: ["src/limiter.test.ts"],
    stubPaths: ["src/limiter.ts"],
    redSha: "bbb222",
    headSha: "ccc333",
    commits: 2,
    writePasses: 1,
    implementPasses: 1,
    sessions: ["red-1", "green-1"],
    costUsd: 0.85,
    sessionRef: "green-1"
  }
]
