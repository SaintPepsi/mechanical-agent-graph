import { nulPaths, PRINCIPLES_PATHSPEC } from "mag/runtime/rulings"

/** The pathspec and the `-z` reader live in `runtime/rulings.ts` now, shared with `review-plan`; re-exported so this node's own callers keep one import. */
export { nulPaths, PRINCIPLES_PATHSPEC }

/**
 * A principles file governs a changed path when its own directory is that path's directory or an
 * ancestor of it. Comparing against the directory *including* its
 * trailing slash is what keeps `dir/` from claiming `dir-other/x.ts`; the root file's directory is
 * the empty string, which every path starts with, which is exactly right.
 *
 * A diff that edits a `PRINCIPLES.md` includes that file in `changed`, so the file governs itself:
 * a change to the rules is reviewed against the rules. A monorepo diff spanning two packages
 * surfaces both package files plus any root file, in git's order, because "the nearest one" would
 * silently drop rules that also apply.
 */
export const governingPrinciples = (
  changed: readonly string[],
  declared: readonly string[]
): readonly string[] =>
  declared.filter((file) => {
    const dir = file.slice(0, file.lastIndexOf("/") + 1)
    return changed.some((path) => path.startsWith(dir))
  })
