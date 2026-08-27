/**
 * Recognizes a criterion line by either of two rules: it's a list item, or it names `AC<n>`.
 * Markdown emphasis is stripped from a line before that `AC<n>` match, because this repo's house
 * ticket format often bolds the criterion label (`**AC.01 - …**`), and `**AC` would otherwise match
 * neither rule.
 */

/** A heading line at any level, hashes captured separately from its text. */
const HEADING = /^(#{1,6})\s*(.*)$/
/** Section anchor: `##+` before "acceptance criteria", case-insensitive, trailing text allowed. */
const SECTION_ANCHOR = /^acceptance criteria\b/i
/** Accepts any list item: `-`, `*`, or a numbered marker, followed by real content. */
const LIST_MARKER = /^(?:[-*]|\d+[.)])\s+/
/** Markdown emphasis runs at either edge of a line, stripped before the `AC<n>` match. */
const EMPHASIS = /^[*_]+|[*_]+$/g
/** A criterion line naming AC<n>, `.` or `-` optional between them. */
const CRITERION_PREFIX = /^AC[.-]?\d/
/** A lone "none" bullet documents an empty section without counting as one. */
const NONE_BULLET = /^none$/i

export interface Recognized {
  readonly criteria: ReadonlyArray<string>
  readonly headings: ReadonlyArray<string>
}

/**
 * Scans a ticket body for an acceptance-criteria section and the criterion lines inside it.
 * `headings` collects every heading line in the body regardless of section, so a refusal can tell
 * the maintainer what their ticket did carry.
 */
export const recognizeAcceptanceCriteria = (body: string): Recognized => {
  const headings: Array<string> = []
  const criteria: Array<string> = []
  let inSection = false

  for (const line of body.split("\n")) {
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const [, hashes, text] = heading
      const title = text.trim()
      headings.push(title)
      // Only a two-hash heading closes the section, so a `###` subsection stays inside it.
      if (hashes.length === 2) inSection = false
      if (hashes.length >= 2 && SECTION_ANCHOR.test(title)) inSection = true
      continue
    }
    if (!inSection) continue

    const stripped = line.replace(/^\s+/, "")
    const listMarker = LIST_MARKER.exec(stripped)
    const content = (listMarker === null ? stripped : stripped.slice(listMarker[0].length)).replace(EMPHASIS, "").trim()

    if (listMarker !== null && NONE_BULLET.test(content)) continue
    if (listMarker !== null || CRITERION_PREFIX.test(content)) criteria.push(line)
  }

  return { criteria, headings }
}
