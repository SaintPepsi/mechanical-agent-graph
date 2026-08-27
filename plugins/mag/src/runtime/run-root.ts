import { createHash } from "node:crypto"

/**
 * Where a run's artifacts live. One global root per machine, so a consumer discovers every run
 * without scanning repo checkouts:
 *
 *   <config-dir>/graph/<project-key>/<ticket>/<run-id>/
 *
 * `run-root.test.ts` pins these composers to a golden table of previously captured values, so a
 * change here can't silently drift from a path a caller already depends on. Run metadata
 * (`run.json`, run-id minting, an artifact-name table) lives elsewhere; a run here writes
 * `journal.jsonl` plus whatever document-shaped artifacts its agent-bearing GraphNodes produce
 * (`design.md`, `build-<pass>.md`, `review-diff-<pass>.md`).
 *
 * Every composer here builds paths with forward slashes and string concatenation rather than
 * `Path.join`: these paths are consumed by shell globs downstream, where a backslash is an escape
 * character that silently matches nothing.
 */

/** The environment slice these functions read. Passed in — nothing here touches `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>

export interface RootParts {
  readonly env: Env
  readonly home: string
}

export interface ProjectParts extends RootParts {
  readonly repoPath: string
}

export interface TicketParts extends ProjectParts {
  readonly ticket: string
}

export interface RunParts extends TicketParts {
  readonly runId: string
}

/**
 * `CLAUDE_CONFIG_DIR` wins over `<home>/.claude`, and backslashes normalise to forward slashes
 * here, once, so every composer below inherits a forward-slash-only value. An empty
 * `CLAUDE_CONFIG_DIR` falls back to the home-derived default via `||`.
 */
export const configDir = (env: Env, home: string): string =>
  (env["CLAUDE_CONFIG_DIR"] || `${home}/.claude`).replace(/\\/g, "/")

export const graphRoot = (env: Env, home: string): string => `${configDir(env, home)}/graph`

/** Where the CLI's own transcripts land, for a consumer globbing for a run's transcript. */
export const transcriptsRoot = (env: Env, home: string): string => `${configDir(env, home)}/projects`

/**
 * Storage key only; display identity comes from the repo path itself. The basename is there so a
 * human can read a directory listing, and the hash is what keeps two checkouts of the same repo (a
 * worktree, a second clone) distinct instead of merged. Trailing slashes and backslashes normalise
 * before hashing, so the same checkout named two ways gets one key.
 */
export const projectKey = (repoPath: string): string => {
  const normal = repoPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = normal.split("/").filter(Boolean).pop() || "repo"
  const hash = createHash("sha256").update(normal).digest("hex").slice(0, 8)
  return `${base.replace(/[^A-Za-z0-9._-]+/g, "-")}-${hash}`
}

export const projectDirFor = ({ env, home, repoPath }: ProjectParts): string =>
  `${graphRoot(env, home)}/${projectKey(repoPath)}`

export const ticketDirFor = (parts: TicketParts): string => `${projectDirFor(parts)}/${parts.ticket}`

export const runDirFor = (parts: RunParts): string => `${ticketDirFor(parts)}/${parts.runId}`

/** The one journal artifact every run writes directly. */
export const journalPathFor = (parts: RunParts): string => `${runDirFor(parts)}/journal.jsonl`

/**
 * May `value` be one path segment under the graph root? The composers above
 * concatenate blindly, so the gate sits with the caller that took the value from outside —
 * `run-layers.ts` checks the ticket id and the run id before any path is built or any file
 * written. Rejected: empty (a vanished segment), `.`/`..` (a hop out of the root), separators
 * (extra segments; backslashes because these paths feed shell globs), and NUL (C-string truncation
 * at the syscall boundary).
 */
export const isSafeSegment = (value: string): boolean =>
  value !== "" &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("\0")
