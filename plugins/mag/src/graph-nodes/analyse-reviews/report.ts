import type { Attribution } from "mag/runtime/review-window"

/**
 * The pure half of `analyse-reviews` — a function from a decoded window and the session's
 * verdict to the markdown the node writes, no I/O. `renderFindings` in `review-diff/graph-node.ts`
 * is the precedent this follows: the first line states the fact a future scan needs, `Analysed
 * through <ISO>` here, `Reviewed at <headSha>` there.
 */

export interface SendBack {
  readonly id: string
  readonly attribution: Attribution
  readonly evidence: string
  readonly fix: string
}

export interface Pattern {
  readonly pattern: string
  readonly attribution: Attribution
  readonly occurrences: readonly string[]
  readonly fix: string
}

export interface AnalysisVerdict {
  readonly sendBacks: readonly SendBack[]
  readonly patterns: readonly Pattern[]
  readonly note: string
}

export interface WindowSummary {
  readonly size: number
  readonly since: string
  readonly through: string
}

/**
 * The report's first line is the next window's watermark — the watermark is the previous report,
 * not a state file. A window of all-clean passes still gets
 * a report — "no send-backs, the loop is converging" is worth knowing, not a skip branch.
 */
export const renderReport = (window: WindowSummary, verdict: AnalysisVerdict): string => {
  const lines: string[] = [
    `Analysed through ${window.through}`,
    `Window: ${window.size} review passes, ${window.since} .. ${window.through}`,
    "",
    "## Send-backs"
  ]

  if (verdict.sendBacks.length === 0) {
    lines.push("None — every pass in this window was clean.")
  } else {
    for (const sendBack of verdict.sendBacks) {
      lines.push(`- ${sendBack.id}: ${sendBack.attribution}`)
      lines.push(`  evidence: ${sendBack.evidence}`)
      lines.push(`  fix: ${sendBack.fix}`)
    }
  }

  lines.push("", "## Patterns")
  if (verdict.patterns.length === 0) {
    lines.push("None.")
  } else {
    for (const pattern of verdict.patterns) {
      const occurrences = pattern.occurrences.join(", ")
      lines.push(`### ${pattern.pattern} (${pattern.attribution}, ${pattern.occurrences.length} occurrences: ${occurrences})`)
      lines.push(pattern.fix)
    }
  }

  if (verdict.note.trim() !== "") lines.push("", "## Note", verdict.note)

  return lines.join("\n")
}

/** Every blocked/dispute-rejected id in the window that the reply's `sendBacks` never named. */
export const missingAttributions = (requiredIds: readonly string[], attributedIds: readonly string[]): readonly string[] => {
  const attributed = new Set(attributedIds)
  return requiredIds.filter((id) => !attributed.has(id))
}
