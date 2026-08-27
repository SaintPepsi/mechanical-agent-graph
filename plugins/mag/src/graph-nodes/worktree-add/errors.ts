import { Data } from "effect"

/**
 * `RunInfo.workRoot` is `""` or equals `repoRoot` — this node was reached outside worktree mode.
 * Degrading to a plain `git worktree add` over the primary checkout would clobber it, so the node
 * refuses rather than silently falling back (`build`'s `BuildRunRootMissing` precedent).
 * `worktree-remove` re-exports this tag for the mirror-image guard: neither node may ever target the
 * primary checkout.
 */
export class WorktreePathUnset extends Data.TaggedError("WORKTREE_PATH_UNSET")<{
  readonly path: string
}> {}

/**
 * `git worktree add --detach` exited non-zero. Covers both refusals git owns atomically: the path
 * already holds a worktree, and the base doesn't resolve locally. No probe is written for either — a
 * probe would duplicate a check git already performs atomically.
 */
export class WorktreeAddFailed extends Data.TaggedError("WORKTREE_ADD_FAILED")<{
  readonly path: string
  readonly base: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * The declared setup command exited non-zero. Distinct from {@link WorktreeAddFailed}: the checkout
 * itself exists and stays on disk for inspection — only what makes it usable failed. Carries an
 * output tail, `verification`'s `TAIL_CAP` convention.
 */
export class WorktreeSetupFailed extends Data.TaggedError("WORKTREE_SETUP_FAILED")<{
  readonly command: string
  readonly exitCode: number
  readonly outputTail: string
}> {}
