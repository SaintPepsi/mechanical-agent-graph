/** C0 (codes 0-31) and C1 (codes 127-159) control characters — the one range check every control-character guard in this node shares. */
export const isControlCode = (code: number): boolean => (code >= 0 && code <= 31) || (code >= 127 && code <= 159)

/**
 * `value` as a double-quoted literal valid in TypeScript source AND in a YAML double-quoted scalar.
 * `graph-nodes/create`'s `template.ts` is the reader: it emits the scaffolded node's `description`
 * through this.
 */
export const escapeQuoted = (value: string): string => {
  // Backslash must be escaped before the double quote — escaping the quote first
  // would double-escape the backslash that step introduces, which is wrong.
  const backslashed = value.replace(/\\/g, "\\\\")
  const quoted = backslashed.replace(/"/g, '\\"')
  // Control characters become a \u-style escape so no raw control byte ever lands in the emitted
  // literal. Everything else, including non-ASCII, passes through verbatim.
  const controlsEscaped = Array.from(quoted)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0
      return isControlCode(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char
    })
    .join("")
  return `"${controlsEscaped}"`
}
