export const inputExamples = [
  {
    remote: "origin",
    branch: "feat/GH-110-push-branch-and-create-pr",
    host: "github.com",
    slug: "SaintPepsi/mechanical-agent-graph",
    base: "main",
    title: "GH-110: push-branch and create-pr graph nodes",
    bodyPath: "/home/dev/repo/.claude/graph/GH-110/run-1/pr-body-1.md"
  }
]

/** `publish.success` is `createPr.success` itself, so this is create-pr's own first example, unchanged. */
export const successExamples = [{ url: "https://github.com/SaintPepsi/mechanical-agent-graph/pull/12" }]
