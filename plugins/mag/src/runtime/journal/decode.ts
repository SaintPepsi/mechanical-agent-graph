import { Schema } from "effect"
import { type JournalRow, JournalRowSchema } from "mag/runtime/journal/row"

/**
 * The one home for a best-effort journal-line decode. Five readers need "one row per line, skip
 * what doesn't parse or decode" — `ps.ts`, `usage-report.ts`'s `collectRows`,
 * `journal/service.ts`'s `readRows`, `resume.ts` and `gather-reviews` — and they all read it from
 * here rather than each carrying a copy.
 *
 * A blank line, a line that isn't valid JSON, or a value that parses but decodes as neither row
 * shape is skipped rather than fatal: a truncated tail is the normal shape of a run killed
 * mid-append, and one bad line must not sink every other row in the file.
 */

const decodeRow = Schema.decodeUnknownSync(JournalRowSchema)

export const decodeJournalLines = (text: string): readonly JournalRow[] => {
  const rows: JournalRow[] = []
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    try {
      rows.push(decodeRow(JSON.parse(line)))
    } catch {
      continue
    }
  }
  return rows
}
