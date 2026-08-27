import { Effect, FileSystem } from "effect"
import { PlatformError } from "effect/PlatformError"

/**
 * Reads a repo's manifests, generic over the caller's own tagged error (`gitRead`'s
 * shape, `runtime/git.ts`) — `detect-svelte`, `detect-effect` and `detect-graph-core` need the
 * identical walk, and a node may import only a sibling's `graph-node`/`errors` public surface, never
 * a private helper inside a sibling's directory (`graph-node.shape.ts`'s `ALLOW_RULES`), so the
 * reader lives here once rather than copied three times (`runtime/git.ts`'s own precedent for
 * the shape).
 */

/** One manifest's answer to the only two questions a probe asks. `dependencies` is the union of
 *  `dependencies` and `devDependencies` — a probe treats them the same. */
export interface Manifest {
  readonly path: string
  readonly name: string | null
  readonly dependencies: ReadonlySet<string>
}

/** The fields a failed read or a failed parse hands the caller's `E` constructor. */
export interface ManifestFailure {
  readonly path: string
  readonly detail: string
}

/** `root === undefined` means "inherit process cwd" (`run-info.ts`'s own `nonEmpty` contract), so
 *  paths are built by string concatenation, never `Path.join` (`design/graph-node.ts`'s precedent:
 *  both sides are already forward-slash paths). */
const joined = (root: string | undefined, relative: string): string => root === undefined ? relative : `${root}/${relative}`

const dependencyNames = (record: Record<string, unknown>, field: string): readonly string[] => {
  const value = record[field]
  return typeof value === "object" && value !== null ? Object.keys(value) : []
}

/** Not JSON, or JSON that isn't an object, both fail `onMalformed`: a repo whose manifest cannot be
 *  parsed is a repo this can't answer about, the same call `design/graph-node.ts`'s
 *  pre-dispatch snapshot read gets wrong by degrading to `""` instead. */
const readOneManifest = <EParse>(
  ioPath: string,
  relativePath: string,
  onMalformed: (failure: ManifestFailure) => EParse
): Effect.Effect<Manifest, PlatformError | EParse, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(ioPath)

    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => onMalformed({ path: ioPath, detail: "not valid JSON" })
    })
    if (typeof parsed !== "object" || parsed === null) {
      return yield* Effect.fail(onMalformed({ path: ioPath, detail: "not a JSON object" }))
    }

    const record = parsed as Record<string, unknown>
    return {
      // Manifest.path is always root-relative, evidence a caller can quote regardless of where the
      // walk actually ran (detect-svelte/effect/graph-core all assert exactly this, e.g. "package.json").
      path: relativePath,
      name: typeof record.name === "string" ? record.name : null,
      dependencies: new Set([...dependencyNames(record, "dependencies"), ...dependencyNames(record, "devDependencies")])
    }
  })

/** `Effect.catch` plus a plain `instanceof` check, not `Effect.catchTag`/`Effect.catchIf`: both typed
 *  tag/refinement combinators degrade when `E` mixes a concrete tagged type with an unconstrained
 *  generic (the caller's own error) — TypeScript's own control-flow narrowing on `instanceof` is what
 *  stays reliable here. Every `PlatformError` this module raises through the caller's own constructor
 *  rather than absorbing goes through here, so the one line that decides "unreadable" is shared by the
 *  glob and every manifest read. */
const orUnreadable = <A, E, R, EIo>(
  effect: Effect.Effect<A, PlatformError | E, R>,
  path: string,
  onUnreadable: (failure: ManifestFailure) => EIo
): Effect.Effect<A, EIo | E, R> =>
  effect.pipe(
    Effect.catch((error: PlatformError | E): Effect.Effect<never, EIo | E, never> =>
      error instanceof PlatformError ? Effect.fail(onUnreadable({ path, detail: error.reason._tag })) : Effect.fail(error)
    )
  )

/**
 * Every `package.json` under `root`, at any depth, `node_modules` pruned — a mono-repo's nested
 * manifests count whether or not the root declares them as workspaces, and a repo
 * whose root has no manifest can still match on a nested one. A repo with no manifest anywhere
 * yields `[]`, the clean non-match, decided once, here, not in three nodes. Sorted so the
 * walk's order is the glob's contract, not the filesystem's. Any `PlatformError`, from the glob or
 * a read, becomes `onUnreadable`.
 */
export const readManifests = <EIo, EParse>(
  root: string | undefined,
  onUnreadable: (failure: ManifestFailure) => EIo,
  onMalformed: (failure: ManifestFailure) => EParse
): Effect.Effect<readonly Manifest[], EIo | EParse, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pattern = "**/package.json"

    const paths = yield* orUnreadable<readonly string[], never, never, EIo>(
      fs.glob(pattern, { exclude: ["**/node_modules/**"], ...(root === undefined ? {} : { root }) }),
      pattern,
      onUnreadable
    )

    const manifests: Array<Manifest> = []
    for (const relative of [...paths].sort()) {
      const ioPath = joined(root, relative)
      manifests.push(yield* orUnreadable(readOneManifest(ioPath, relative, onMalformed), ioPath, onUnreadable))
    }
    return manifests
  })

/** Pure: which of these manifests declare `dependency`, in `dependencies` or `devDependencies` alike. */
export const declaring = (manifests: readonly Manifest[], dependency: string): readonly Manifest[] =>
  manifests.filter((manifest) => manifest.dependencies.has(dependency))

/** The manifest's directory, root-relative: its `path` with the trailing `/package.json` removed.
 *  The root manifest's own path is exactly `"package.json"` (its own doc comment above), so its
 *  directory is `""` — never fed to `suffixesOf` below, since the root is always a candidate on its
 *  own account, not by naming an empty path. */
const directoryOf = (manifest: Manifest): string => manifest.path.slice(0, -"package.json".length).replace(/\/$/, "")

/** Every parent-inclusive suffix of a directory path: `"plugins/mag/projects/graph-viewer"` yields
 *  itself, `"mag/projects/graph-viewer"`, `"projects/graph-viewer"` and `"graph-viewer"` — a ticket
 *  that names the leaf directory alone is naming the project as plainly as one that spells the whole
 *  path. */
const suffixesOf = (directory: string): readonly string[] => {
  const segments = directory.split("/")
  return segments.map((_, index) => segments.slice(index).join("/"))
}

/**
 * A manifest is a candidate for a stack probe's match only if `text` (the ticket's own
 * title+body) plausibly points at it — the root manifest always qualifies,
 * and any other manifest qualifies only by naming its directory (in full or by a trailing
 * suffix) or its own `name` field somewhere in `text`. Without that narrowing, a second manifest
 * declaring the same dependency anywhere in the checkout would make every ticket match regardless
 * of what it touched — a nested project at a path like `plugins/mag/projects/graph-viewer` is
 * exactly that shape. Pure: no read, no model judgment.
 */
export const candidates = (manifests: readonly Manifest[], text: string): readonly Manifest[] =>
  manifests.filter((manifest) => {
    if (manifest.path === "package.json") return true
    const directory = directoryOf(manifest)
    const namesPath = directory !== "" && suffixesOf(directory).some((suffix) => text.includes(suffix))
    const namesPackage = manifest.name !== null && text.includes(manifest.name)
    return namesPath || namesPackage
  })
