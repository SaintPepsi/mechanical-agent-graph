const ESCAPE = {
  path: "src/limiter.ts",
  find: "this.hits.delete(key)",
  replace: "this.hits.clear()",
  probeSource: "bun -e 'console.log(1)'"
}

export const inputExamples = [{ escapes: [ESCAPE] }, { escapes: [], model: "haiku" }]

export const successExamples = [
  { rated: [{ ...ESCAPE, category: "isolation", severity: 3 }], sessions: ["a1b2c3"], costUsd: 0.02 },
  { rated: [], sessions: [], costUsd: 0 }
]
