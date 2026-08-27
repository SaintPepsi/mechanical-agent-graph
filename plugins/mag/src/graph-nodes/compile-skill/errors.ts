import { Data } from "effect"

/** The resolved root does not exist, or its existence couldn't be determined (e.g. a pathological
 * `--root` makes the platform's own check raise). Either way this node can't render into it: a
 * typo'd `--root` must not silently materialize a phantom skills tree, and a platform error from
 * the existence check itself is not grounds to widen the node's error union past this tag (repo
 * `CLAUDE.md`: unfit paths error rather than being worked around). */
export class SkillsRootMissing extends Data.TaggedError("COMPILE_SKILL_ROOT_MISSING")<{
  readonly root: string
}> {}

/** Creating a skill's own directory under an existing root, or writing its file, failed.
 * `PlatformError` is caught and named here so the node's inferred error union stays domain tags
 * only (precedent: `design/graph-node.ts`'s `DesignCopyFailed`, `create/scaffold.ts`'s `ScaffoldFailed`). */
export class SkillWriteFailed extends Data.TaggedError("COMPILE_SKILL_WRITE_FAILED")<{
  readonly path: string
  readonly detail: string
}> {}
