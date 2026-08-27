export const inputExamples = [{ testPaths: ["src/limiter.test.ts"] }]

export const successExamples = [
  { findings: [], tests: 4 },
  {
    findings: [
      {
        path: "src/limiter.test.ts",
        severity: "error",
        rule: "no-assertion",
        line: 12,
        message: "\"resets\" runs code but asserts nothing: it passes for every possible behaviour of the code it calls."
      }
    ],
    tests: 4
  }
]
