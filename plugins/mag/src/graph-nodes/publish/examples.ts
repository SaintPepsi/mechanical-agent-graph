export const inputExamples = [
  {
    remote: "origin",
    branch: "feat/GH-110-push-branch-and-create-pr",
    host: "github.com",
    slug: "SaintPepsi/mechanical-agent-graph",
    base: "main",
    title: "GH-110: push-branch and create-pr graph nodes",
    body: "Fixes the NUL-byte crash at the artifact writer.\n\nCloses #110\n\nrun: 019bd0f4-3c21-7f1a-9c0e-2f0f2c1a4b77"
  }
]

/** `publish.success` is `createPr.success` itself, so this is create-pr's own first example, unchanged. */
export const successExamples = [{ url: "https://github.com/SaintPepsi/mechanical-agent-graph/pull/12" }]
