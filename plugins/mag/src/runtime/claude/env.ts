import type { Env } from "mag/runtime/run-root"

/**
 * What a spawned session is allowed to know about the machine it runs on.
 *
 * `Bun.spawn` inherits the whole parent environment by default, and Bun auto-loads a target repo's
 * `.env` into that parent environment before a node ever runs. A tracker token, a cloud credential
 * or a database URL sitting in the repo a run is working on would otherwise reach a model-driven
 * process that is free to run shell commands. The fix is a list, not a filter: a value with no name
 * on {@link ENV_MANIFEST} has no path into the child, however it got into the host's environment.
 */

/**
 * The named list of variables a session may ever hold. Growing this list is the one supported way
 * to widen what a spawned session can see, and it is a one-line, reviewed diff.
 */
export const ENV_MANIFEST: readonly string[] = [
  // The floor a process needs to run at all.
  "PATH",
  "HOME",
  "TMPDIR",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  // Where the pipeline's own tooling keeps its state. `gh` and `git` read config and credentials
  // from `XDG_CONFIG_HOME` when it is set. `GH_TOKEN`/`GITHUB_TOKEN` are deliberately absent: every
  // `gh` call this pipeline makes runs through `Shell` in the parent process (`fetch-ticket`,
  // `create-pr`), never inside a spawned session, so no session needs a token here, and naming one
  // would admit exactly the credential class this manifest exists to keep out.
  "XDG_CONFIG_HOME",
  // The pipeline's own names. `CLAUDE_CONFIG_DIR` points transcript readers at the same
  // `<configDir>/projects` the child writes to (`run-root.ts`'s `transcriptsRoot`), and dropping it
  // would point a reviewer at transcripts that are not where they are told to look. A nested run
  // inside a session needs `GRAPH_ISOLATE_CONFIG` and `GRAPH_TRACE_FILE` to cross the boundary the
  // same way this pipeline running itself already depends on.
  "CLAUDE_CONFIG_DIR",
  "GRAPH_ISOLATE_CONFIG",
  "GRAPH_TRACE_FILE",
  // The escape hatch's own flag. On the manifest so the hatch itself cannot be opened by a value
  // the manifest would otherwise withhold.
  "KEEP_ANTHROPIC_ENV"
]

/**
 * Manifest names the host actually set, plus the host's own `ANTHROPIC_*` keys when the escape
 * hatch is on. The hatch re-admits only that one prefix, never the whole host record: the wider
 * reading is today's leak with an extra step.
 */
export const composeEnv = (host: Env): Env => {
  const picked: Record<string, string | undefined> = {}
  for (const name of ENV_MANIFEST) {
    if (host[name] !== undefined) picked[name] = host[name]
  }
  if (host["KEEP_ANTHROPIC_ENV"] === "1") {
    for (const [key, value] of Object.entries(host)) {
      if (key.startsWith("ANTHROPIC_") && value !== undefined) picked[key] = value
    }
  }
  return picked
}

/** Why a declared requirement is missing from the composed environment. */
export type ShortfallReason = "withheld" | "unset"

/** One declared requirement the composed environment does not satisfy. */
export interface EnvShortfall {
  readonly name: string
  readonly reason: ShortfallReason
}

/**
 * The first name in `requires` that `env` (a {@link composeEnv} result) does not hold, or `null`
 * when every one is satisfied. The reason comes from manifest membership, not from whether the host
 * happens to hold a value on this particular run: `withheld` means the name is not on
 * {@link ENV_MANIFEST}, so a manifest line is the fix regardless of what the host holds right now;
 * `unset` means the name is on the manifest and the host does not hold it, so the operator exporting
 * it is the fix, no code change needed. Deciding "unset" from host presence alone would report an
 * off-manifest, host-empty name as "unset" on this run and "withheld" the moment the operator
 * exports it, needing two runs to surface the one manifest line that was the real fix all along.
 * Declaration order decides which shortfall surfaces first when several names are missing, matching
 * every other first-failure rule in this transport.
 */
export const envShortfall = (requires: readonly string[], env: Env): EnvShortfall | null => {
  for (const name of requires) {
    if (env[name] !== undefined) continue
    return { name, reason: ENV_MANIFEST.includes(name) ? "unset" : "withheld" }
  }
  return null
}
