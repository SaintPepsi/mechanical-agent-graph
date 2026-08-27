// Fixtures for the conformance node's own contract self-check (decode against its input/success schemas).
export const inputExamples = [{}, { name: "conformance" }, { root: "/tmp/x" }]

export const successExamples = [
  { root: "/tmp/x", checked: [] },
  { root: "/tmp/x", checked: ["conformance", "registry"] },
]
