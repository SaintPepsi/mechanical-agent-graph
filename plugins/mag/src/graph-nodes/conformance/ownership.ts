import { Option } from "effect"
import { importSpecifiers, nodeInternalTarget, REQUIRED_FILES } from "mag/runtime/graph-node.shape"

/** The mandatory four, derived from REQUIRED_FILES rather than restated. */
const REQUIRED_FILE_SET = new Set<string>(REQUIRED_FILES)

/**
 * Which extras may exist at all (`.ts`, not a directory) vs junk. Directory check BEFORE extension
 * check — `looks-like.ts` as a directory is junk, never a source. `.d.ts` ends `.ts`, so it counts
 * as a source like any other extra — no extension special-casing.
 */
export const classifyExtras = (
  entries: readonly string[],
  directories: readonly string[]
): { readonly extraSources: readonly string[]; readonly extraJunk: readonly string[] } => {
  const extraSources: string[] = []
  const extraJunk: string[] = []

  for (const entry of entries) {
    if (REQUIRED_FILE_SET.has(entry)) continue
    if (directories.includes(entry) || !entry.endsWith(".ts")) {
      extraJunk.push(entry)
    } else {
      extraSources.push(entry)
    }
  }

  return { extraSources, extraJunk }
}

const TEST_SUFFIX = ".test.ts"

/** The sibling source file a `<name>.test.ts` claims ownership through, if any. */
export const subjectFileFor = (file: string): Option.Option<string> =>
  file.endsWith(TEST_SUFFIX) ? Option.some(`${file.slice(0, -TEST_SUFFIX.length)}.ts`) : Option.none()

/**
 * The filenames this node owns, in two phases. Phase one closes the import graph from
 * `REQUIRED_FILES ∩ keys(sources)` as fixed roots — never a fixed point, so an owned extra test
 * file confers nothing further; roots are the four required files only. Phase two runs once, after
 * the closure settles: any `<name>.test.ts` in `sources` whose sibling `<name>.ts` is in the
 * closure is owned too, so an owned sibling includes a required one.
 */
export const ownedFiles = (sources: ReadonlyMap<string, string>, nodeName: string): ReadonlySet<string> => {
  const roots = REQUIRED_FILES.filter((file) => sources.has(file))
  const reachable = new Set<string>(roots)
  const worklist: string[] = [...roots]

  while (worklist.length > 0) {
    const current = worklist.pop()!
    const text = sources.get(current)
    if (text === undefined) continue

    for (const specifier of importSpecifiers(text)) {
      const target = nodeInternalTarget(specifier, nodeName)
      if (Option.isNone(target)) continue

      const filename = target.value
      if (reachable.has(filename) || !sources.has(filename)) continue

      reachable.add(filename)
      worklist.push(filename)
    }
  }

  const owned = new Set<string>(reachable)
  for (const filename of sources.keys()) {
    const subjectFile = subjectFileFor(filename)
    if (Option.isSome(subjectFile) && reachable.has(subjectFile.value)) owned.add(filename)
  }

  return owned
}
