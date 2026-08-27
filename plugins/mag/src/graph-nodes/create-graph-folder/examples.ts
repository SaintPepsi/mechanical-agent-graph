export const inputExamples = [{ name: "envision" }, { name: "design-graph" }]
export const successExamples = [
  { folder: "/home/dev/repo/plugins/mag/src/graphs/envision", created: true },
  // The fixture keeps naming a folder that actually exists on disk (graphs/design-graph).
  { folder: "/home/dev/repo/plugins/mag/src/graphs/design-graph", created: false }
]
