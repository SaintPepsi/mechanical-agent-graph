/**
 * The run's execution root, a sibling of the primary checkout. Deliberately kept apart from
 * `run-root.ts`: that file answers "where do a run's artifacts live", under `CLAUDE_CONFIG_DIR`; this
 * one answers "where does a run work", beside the checkout. Same
 * conventions as `run-root.ts`: forward slashes and string concatenation, never `Path.join`, since
 * these values feed shell globs downstream, where a backslash is an escape character that silently
 * matches nothing.
 */

export interface WorktreeParts {
  readonly repoPath: string
  readonly ticket: string
  readonly runId: string
}

/** Backslashes normalise to forward slashes, and a trailing slash is stripped, once, before any split. */
const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "")

/** `<dir>/<base>` split on the last `/` — a repo one level below the filesystem root leaves `dir` empty. */
const splitPath = (path: string): { readonly dir: string; readonly base: string } => {
  const index = path.lastIndexOf("/")
  return index === -1 ? { dir: "", base: path } : { dir: path.slice(0, index), base: path.slice(index + 1) }
}

/**
 * One container beside the checkout, rather than a flat `../<repo>-<TICKET>` sibling
 * per run. A failed run keeps its tree, so a flat convention would litter the
 * checkout's parent with one entry per kept run, forever. A container keeps the parent at exactly
 * one extra entry, and `ls` on it is a forensic inventory of what a run left behind.
 */
export const worktreeContainerFor = (repoPath: string): string => {
  const { dir, base } = splitPath(normalize(repoPath))
  return `${dir}/${base}-worktrees`
}

/**
 * The run id in the leaf is what makes the path run-scoped rather than ticket-scoped:
 * a per-ticket path would collide with the previous failed run's kept tree on every retry.
 * Both segments are already gated by `run-root.ts`'s `isSafeSegment` before this is ever called
 * (`run-layers.ts`), so no second validator lives here.
 */
export const worktreeDirFor = (parts: WorktreeParts): string =>
  `${worktreeContainerFor(parts.repoPath)}/${parts.ticket}-${parts.runId}`
