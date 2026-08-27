import { Data } from "effect"

/**
 * `publish/errors.ts`'s precedent: a re-export of a sibling's tag rather than a second class for the
 * identical condition. `worktree-remove` must never target the primary checkout — that would be the
 * mirror image of the clobber `worktree-add` itself refuses. A sibling's `errors` module is
 * explicitly part of the public surface a node may import (`graph-node.shape.ts`'s `siblingPublicSurface`).
 */
export { WorktreePathUnset } from "mag/graph-nodes/worktree-add/errors"

/** `git worktree remove` exited non-zero. The tree survives, which is the safe direction: never forced, never retried. */
export class WorktreeRemoveFailed extends Data.TaggedError("WORKTREE_REMOVE_FAILED")<{
  readonly path: string
  readonly exitCode: number
  readonly stderr: string
}> {}
