export const inputExamples = [
  {
    visionPath: "/home/dev/repo/plugins/mag/src/graphs/design-graph/vision.md",
    derivedVisionPath: "/home/dev/.config/graph/repo/GH-293/code-to-vision-review/run-1/derived-vision-1.md"
  }
]
export const successExamples = [
  {
    reportPath: "/home/dev/.config/graph/repo/GH-293/code-to-vision-review/run-1/code-to-vision-1.md",
    findings: [],
    divergent: false
  },
  {
    reportPath: "/home/dev/.config/graph/repo/GH-293/code-to-vision-review/run-1/code-to-vision-1.md",
    findings: [
      { kind: "node-absent-from-code", name: "transform" },
      { kind: "node-absent-from-vision", name: "convert" }
    ],
    divergent: true
  }
]
