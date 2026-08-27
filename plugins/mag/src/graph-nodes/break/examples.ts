export const inputExamples = [
  { srcPaths: ["src/limiter.ts"], testPaths: ["src/limiter.test.ts"], budget: 3 },
  { srcPaths: ["src/limiter.ts", "src/sync.ts"], testPaths: ["src/limiter.test.ts"], budget: 5, agent: "effect-expert", model: "sonnet" }
]

export const successExamples = [
  { claims: [], sessions: ["a1b2c3"], costUsd: 0.4 },
  {
    claims: [
      {
        path: "src/limiter.ts",
        find: "this.hits.delete(key)",
        replace: "this.hits.clear()",
        probeSource: "bun -e 'const { Limiter } = await import(\"./src/limiter.ts\"); const l = new Limiter(); l.check(\"a\"); l.check(\"b\"); l.reset(\"a\"); console.log(l.count(\"b\"))'",
        rationale: "reset(key) wipes every key's state, a cross-tenant quota reset"
      }
    ],
    sessions: ["a1b2c3"],
    costUsd: 0.4
  }
]
