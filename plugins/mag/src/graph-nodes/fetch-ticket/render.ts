import { Schema } from "effect"

// The wire shape gh issue view is trusted to match; a field gh stops emitting is a decode failure, not a silent empty render.
export const Author = Schema.Struct({ login: Schema.String })

const IssueShape = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  author: Author,
  comments: Schema.Array(Schema.Struct({ author: Author, body: Schema.String, createdAt: Schema.String }))
})

export type Issue = typeof IssueShape.Type

/** Decodes `gh`'s JSON stdout directly. */
export const Issue = Schema.fromJsonString(IssueShape)

// Every line prefixed with "> ": a raw ## heading in a comment would otherwise outdent past the Comments section.
const blockquote = (text: string): string => text.split("\n").map((line) => `> ${line}`).join("\n")

// The whole comment-filtering/rendering rule, pure and unit-testable without a subprocess.
export const renderBody = (issue: Issue, maintainer: string): string => {
  if (issue.comments.length === 0) return issue.body

  const kept = issue.comments.filter((comment) => comment.author.login === maintainer)
  const withheldCount = issue.comments.length - kept.length

  let body = `${issue.body}\n\n## Comments`
  for (const comment of kept) {
    body += `\n\n### ${comment.createdAt}\n\n${blockquote(comment.body)}`
  }
  if (withheldCount > 0) {
    const noun = withheldCount === 1 ? "comment" : "comments"
    body += `\n\n_${withheldCount} ${noun} by other authors withheld._`
  }
  return body
}
