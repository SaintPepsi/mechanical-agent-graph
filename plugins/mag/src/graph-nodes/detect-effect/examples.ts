export const inputExamples = [{ text: "Fix a race condition in the effect runtime" }]

export const successExamples = [
  { stack: "effect", matched: true, manifests: ["package.json"] },
  { stack: "effect", matched: true, manifests: ["packages/server/package.json"] },
  { stack: "effect", matched: false, manifests: [] }
]
