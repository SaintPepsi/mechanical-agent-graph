export const inputExamples = [{ base: "main", target: "feat/gh-184-fix" }]

export const successExamples = [
  {
    base: "main",
    target: "feat/gh-184-fix",
    baseSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    targetSha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    conflicts: []
  },
  {
    base: "main",
    target: "feat/gh-184-fix",
    baseSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    targetSha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
    conflicts: ["src/foo.ts", "src/bar.ts"]
  }
]
