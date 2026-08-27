/**
 * The two exact-name pathspecs git is asked for: the root file and any
 * file nested at any depth, anchored at the repo root by the `:/` magic. Deliberately not
 * `'*PRINCIPLES.md'` — that also matches `MY_PRINCIPLES.md`, and a reviewer told that someone's
 * meeting notes are binding criteria produces findings nobody asked for. The direction names one
 * filename.
 */
export const PRINCIPLES_PATHSPEC = [":/PRINCIPLES.md", ":/*/PRINCIPLES.md"] as const

/** `-z` output: NUL-terminated, never quoted, so the split is the whole parse. */
export const nulPaths = (stdout: string): readonly string[] => stdout.split("\0").filter((path) => path !== "")

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
