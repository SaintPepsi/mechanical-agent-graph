export const inputExamples = [
  {
    host: "github.com",
    slug: "SaintPepsi/mechanical-agent-graph",
    base: "main",
    source: "feat/GH-110-push-branch-and-create-pr",
    title: "GH-110: push-branch and create-pr graph nodes",
    body: "Fixes the NUL-byte crash at the artifact writer.\n\nCloses #110\n\nrun: 019bd0f4-3c21-7f1a-9c0e-2f0f2c1a4b77"
  },
  {
    host: "gitlab.example.com",
    slug: "group/project",
    base: "main",
    source: "feat/GH-110-push-branch-and-create-pr",
    title: "GH-110: push-branch and create-pr graph nodes",
    body: "Fixes the NUL-byte crash at the artifact writer.\n\nCloses #110\n\nrun: 019bd0f4-3c21-7f1a-9c0e-2f0f2c1a4b77"
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
