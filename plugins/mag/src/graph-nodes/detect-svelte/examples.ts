export const inputExamples = [{ text: "Add a settings panel to the graph-viewer app" }]

export const successExamples = [
  { stack: "svelte", matched: true, manifests: ["package.json"] },
  { stack: "svelte", matched: true, manifests: ["apps/web/package.json"] },
  { stack: "svelte", matched: false, manifests: [] }
]
