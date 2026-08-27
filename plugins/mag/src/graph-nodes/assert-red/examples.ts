export const inputExamples = [
  { testPaths: ["src/limiter.test.ts", "src/sync.test.ts"], sha: "aaa111", command: "bun test \"$1\"" }
]

export const successExamples = [
  { red: ["src/limiter.test.ts", "src/sync.test.ts"], green: [], broken: [] },
  { red: ["src/limiter.test.ts"], green: ["src/sync.test.ts"], broken: [] },
  { red: [], green: [], broken: ["src/limiter.test.ts"] }
]
