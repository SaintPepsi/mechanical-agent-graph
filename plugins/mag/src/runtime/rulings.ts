/**
 * Where a target repository states its rulings, as git pathspecs, and the reader for git's `-z`
 * output. Shared by `review-diff` (which scopes `PRINCIPLES.md` files to the paths a diff touches)
 * and `review-plan` (which hands every `CLAUDE.md` and `PRINCIPLES.md` to a reviewer with no diff
 * to scope by): a boundary no single node can own, `runtime/git.ts`'s reasoning.
 *
 * Exact-name pathspecs, the root file and any file nested at any depth, anchored at the repo root
 * by the `:/` magic. Deliberately not `'*PRINCIPLES.md'`: that also matches `MY_PRINCIPLES.md`, and
 * a reviewer told that someone's meeting notes are binding criteria produces findings nobody asked
 * for. Each direction names one filename.
 */
export const PRINCIPLES_PATHSPEC = [":/PRINCIPLES.md", ":/*/PRINCIPLES.md"] as const

/** Every rulings file: the `CLAUDE.md` family at any depth beside the principles pathspec. */
export const RULINGS_PATHSPEC = [":/CLAUDE.md", ":/*/CLAUDE.md", ":/**/CLAUDE.md", ...PRINCIPLES_PATHSPEC] as const

/** `-z` output: NUL-terminated, never quoted, so the split is the whole parse. */
export const nulPaths = (stdout: string): readonly string[] => stdout.split("\0").filter((path) => path !== "")
