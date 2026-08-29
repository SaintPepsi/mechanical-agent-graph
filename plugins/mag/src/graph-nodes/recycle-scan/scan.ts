/**
 * The pure half of `recycle-scan`: which names a design puts in backticks, which spellings each
 * one is searched under, where a file matches, and the table those matches render as. No I/O,
 * so `graph-node.ts` is the only place a file is read or written.
 */

/** One place a name was found: a line of a file, or the file's own path. */
export interface Hit {
  readonly path: string
  readonly line?: number
}

export interface ScanRow {
  readonly name: string
  readonly hits: readonly Hit[]
}

/** Hits listed per name before the rest collapse into a count. */
export const HIT_CAP = 12

/**
 * Every backticked span with no whitespace inside it, first appearance order, no repeats. A span
 * with a space is prose the design quoted, never an identifier a repo could hold under that name.
 */
export const backtickedNames = (design: string): readonly string[] => {
  const names: string[] = []
  for (const match of design.matchAll(/`([^`\n]+)`/g)) {
    const name = match[1]!.trim()
    if (name === "" || /\s/.test(name) || names.includes(name)) continue
    names.push(name)
  }
  return names
}

/** The words of a name, lowercased: kebab, snake, dotted and camel boundaries all split. */
const wordsOf = (name: string): readonly string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase())

/**
 * The spellings one name is searched under: as written, then kebab, camel and snake case of its
 * words. A repo names the same thing differently per layer (a file in kebab, a symbol in camel),
 * so a match under any spelling is the same prior art.
 */
export const caseVariants = (name: string): readonly string[] => {
  const words = wordsOf(name)
  if (words.length === 0) return [name]
  const kebab = words.join("-")
  const snake = words.join("_")
  const camel = words.map((word, index) => (index === 0 ? word : word[0]!.toUpperCase() + word.slice(1))).join("")
  return [...new Set([name, kebab, camel, snake])]
}

/** Where `variants` occur in one file: its path when the path carries one, then each line that does. */
export const hitsIn = (path: string, text: string, variants: readonly string[]): readonly Hit[] => {
  const hits: Hit[] = []
  if (variants.some((variant) => path.includes(variant))) hits.push({ path })
  text.split("\n").forEach((line, index) => {
    if (variants.some((variant) => line.includes(variant))) hits.push({ path, line: index + 1 })
  })
  return hits
}

const renderHit = (hit: Hit): string => (hit.line === undefined ? hit.path : `${hit.path}:${hit.line}`)

/** One table, one row per hit up to `HIT_CAP` per name, then one row counting the rest; a name with no hit gets one row saying so. */
export const renderScan = (designPath: string, rows: readonly ScanRow[]): string =>
  [
    "# Recycle scan",
    "",
    `Every backticked name in ${designPath}, searched as written and in kebab, camel and snake case across the files git tracks.`,
    "",
    "| Name | Hit |",
    "| --- | --- |",
    ...rows.flatMap((row) => {
      if (row.hits.length === 0) return [`| \`${row.name}\` | none |`]
      const shown = row.hits.slice(0, HIT_CAP).map((hit) => `| \`${row.name}\` | ${renderHit(hit)} |`)
      const rest = row.hits.length - HIT_CAP
      return rest > 0 ? [...shown, `| \`${row.name}\` | +${rest} more |`] : shown
    })
  ].join("\n") + "\n"
