export const inputExamples = [
  { text: "GraphNodes: [+] `recycle-scan` [-] `recycle-map`\n\nReplace the reuse session with a grep." },
  { text: "Fix the README's install command." }
]

export const successExamples = [
  { stack: "graph-core", matched: true, manifests: ["package.json"] },
  { stack: "graph-core", matched: false, manifests: [] }
]
