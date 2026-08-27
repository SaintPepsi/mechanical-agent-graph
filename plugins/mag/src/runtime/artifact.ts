import { Effect, type FileSystem } from "effect"
import type { PlatformError } from "effect/PlatformError"

/**
 * The mechanical half of "artifacts are the default output for agent-bearing GraphNodes". Knows
 * nothing about `build` or `review-diff` — no domain validation, no schema — so both nodes reuse
 * it and each wraps its own `PlatformError` into its own tagged error, `design/errors.ts`'s
 * `DesignCopyFailed` precedent.
 *
 * Names each write `<prefix>-<pass>.<extension>`, `pass` a 1-based count of how many
 * `<prefix>-*` files already exist in `runRoot` (extension-agnostic: a `diff` prefix's `.patch`
 * files count the same as a `build` prefix's `.md` files count for themselves — the filter is on
 * the prefix, not the suffix). `runRoot` is single-writer and sequential within one run (the same
 * invariant `journalLayer`'s own `Ref` leans on), so counting on-disk files stands in for a shared
 * counter with no session-id assumption — the naming problem `review-diff`'s resumed delta pass
 * would otherwise hit, since a resumed call's `reply.sessions[0]` is the same session id as the
 * pass it resumed.
 *
 * `extension` defaults to `"md"`, which is what eight of the twelve call sites want. The other four
 * name their own (`review-diff` and `write-pr-body` a `"patch"`, `verification` a `"txt"`,
 * `write-ticket` a `"json"`) rather than growing a second numbering scheme of their own.
 */
export const writeArtifact = (
  fs: FileSystem.FileSystem,
  runRoot: string,
  prefix: string,
  content: string,
  extension: string = "md"
): Effect.Effect<string, PlatformError> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(runRoot, { recursive: true })
    const existing = yield* fs.readDirectory(runRoot)
    const pass = existing.filter((name) => name.startsWith(`${prefix}-`)).length + 1
    const path = `${runRoot}/${prefix}-${pass}.${extension}`
    yield* fs.writeFileString(path, content)
    return path
  })
