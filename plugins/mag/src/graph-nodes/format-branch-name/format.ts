/**
 * The branch name is computed, never typed: the documented convention is
 * `[feat|bugfix|task|chore]/<TICKET>-<kebab-title>`.
 *
 * Everything here is pure and total. A ticket id that normalises to nothing is the one edge case:
 * the node turns that condition into a tagged error rather than a null return.
 */

const MAX_SLUG = 48

/**
 * Lowercase, every run of non-alphanumerics to a single `-`, trimmed. That mapping also makes every
 * character git forbids in a ref unrepresentable, so there is no separate validation pass to keep in
 * sync with it.
 */
export const slugify = (title: string, max: number = MAX_SLUG): string => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max + 1)
  const boundary = cut.lastIndexOf("-")
  return (boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, max)).replace(/-+$/, "")
}

/** Labels name the work's kind; the convention's type slot is the same vocabulary. */
const TYPE_BY_LABEL: Record<string, string> = {
  bug: "bugfix",
  bugfix: "bugfix",
  defect: "bugfix",
  fix: "bugfix",
  regression: "bugfix",
  chore: "chore",
  docs: "chore",
  documentation: "chore",
  refactor: "chore",
  task: "task"
}

export const DEFAULT_BRANCH_TYPE = "feat"

export const branchType = (labels: readonly string[]): string => {
  for (const label of labels) {
    const type = TYPE_BY_LABEL[label.toLowerCase()]
    if (type !== undefined) return type
  }
  return DEFAULT_BRANCH_TYPE
}

/** The ticket id reduced to what a git ref may carry. Empty means there was no usable id. */
export const normaliseTicketId = (ticket: string): string =>
  ticket.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")

/**
 * Trackers hand back titles like "EP-1633 — Add sitting location". The id is already the branch's
 * own prefix, so repeating it in the slug reads as a stutter; strip one leading copy.
 */
export const formatBranchName = (
  id: string,
  title: string,
  labels: readonly string[]
): string => {
  const slug = slugify(title).replace(new RegExp(`^${id.toLowerCase()}-`), "")
  return `${branchType(labels)}/${id}${slug ? `-${slug}` : ""}`
}
