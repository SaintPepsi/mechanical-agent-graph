import { Effect } from "effect"
import { type GitFailureFields, gitReadRaw } from "mag/runtime/git"

/**
 * Where a target repository states its rulings, as git pathspecs, the reader for git's `-z`
 * output, and the one read plus prompt block that hands every rulings file to a session. Shared by
 * `review-diff` (which scopes `PRINCIPLES.md` files to the paths a diff touches), `review-plan`
 * (which hands every `CLAUDE.md` and `PRINCIPLES.md` to a reviewer with no diff to scope by) and
 * `brainstorm` (whose design must rule against the same files the reviewer will hold it to): a
 * boundary no single node can own, `runtime/git.ts`'s reasoning.
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

/**
 * The rulings files git tracks under `cwd`, repo-root-relative. `ls-files` rather than a directory
 * walk so an untracked or ignored draft never binds a session. Generic over the caller's own tagged
 * error, `gitReadRaw`'s contract: a closed error union stays closed.
 */
export const declaredRulings = <E>(cwd: string | undefined, onFailure: (fields: GitFailureFields) => E) =>
  gitReadRaw(["git", "ls-files", "-z", "--full-name", "--", ...RULINGS_PATHSPEC], cwd, onFailure).pipe(Effect.map(nulPaths))

/** The prompt lines naming the declared rulings files, or none. Paths are what git returned, which resolve from the session's cwd. */
export const rulingsBlock = (rulings: readonly string[]): readonly string[] =>
  rulings.length === 0 ? [] : [
    "",
    "This repository states rulings of its own, in the files below:",
    ...rulings.map((file) => `- ${file}`)
  ]
