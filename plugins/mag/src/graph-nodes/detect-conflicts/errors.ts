import { Data } from "effect"

/**
 * `git rev-parse --verify -q refs/heads/<ref>` found nothing for `base` or `target`. Checked
 * before `merge-tree` ever runs: `merge-tree`'s own exit 1 means both "conflicts" and "that ref is
 * not something I can merge", so an unverified ref would report a typo'd branch name as a
 * conflicting one, and no agent is ever reachable from this state.
 */
export class ConflictRefMissing extends Data.TaggedError("CONFLICT_REF_MISSING")<{
  readonly ref: string
}> {}

/**
 * `git merge-tree --write-tree --name-only -z` exited something this node cannot read as a verified
 * conflict: a non-0/1 exit (128 unrelated histories, or anything else), or an exit 1 whose stdout
 * named no conflicting path at all. Both refs are already verified by the time this runs, so an
 * exit 1 naming nothing is git saying "conflict" and the parse finding nothing — a state this node
 * cannot judge (unfit paths error, repo `CLAUDE.md`), not a clean run.
 */
export class ConflictProbeFailed extends Data.TaggedError("CONFLICT_PROBE_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}
