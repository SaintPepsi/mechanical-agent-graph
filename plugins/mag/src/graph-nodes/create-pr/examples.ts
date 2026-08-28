export const inputExamples = [
  {
    host: "github.com",
    slug: "SaintPepsi/mechanical-agent-graph",
    base: "main",
    source: "feat/GH-110-push-branch-and-create-pr",
    title: "GH-110: push-branch and create-pr graph nodes",
    bodyPath: "/home/dev/repo/.claude/graph/GH-110/run-1/pr-body-1.md"
  },
  {
    host: "gitlab.example.com",
    slug: "group/project",
    base: "main",
    source: "feat/GH-110-push-branch-and-create-pr",
    title: "GH-110: push-branch and create-pr graph nodes",
    bodyPath: "/home/dev/repo/.claude/graph/GH-110/run-1/pr-body-1.md"
  }
]
export const successExamples = [
  { url: "https://github.com/SaintPepsi/mechanical-agent-graph/pull/12" },
  {
    url: "https://gitlab.example.com/group/project/-/merge_requests/new" +
      "?merge_request%5Bsource_branch%5D=feat%2FGH-110-push-branch-and-create-pr" +
      "&merge_request%5Btarget_branch%5D=main"
  }
]
