import type { Ticket } from "mag/skills/ticket/schema"

/**
 * A validated `Ticket` to house-style markdown. Pure: no I/O, no dispatch-time facts, every line
 * comes from a field already on `ticket`.
 *
 * Follows `.github/ISSUE_TEMPLATE/ticket.md` where the two overlap, and a filed ticket's own house
 * style otherwise: Title Case section headings, and the `> Depends on: … · Blocks: …` line last,
 * after every criterion, matching `Ticket`'s own field order rather than the template's
 * mid-document placement. No `## User stories` section: the structure rendered here is exhaustive
 * and does not include one.
 */

/**
 * Criterion ids are positions, not a field the writer states (`schema.ts`'s own comment): numbered
 * here, `01`-padded so a run past nine stays sorted. `&nbsp;` forces a line break within one
 * markdown paragraph; the block's last line needs none, there is nothing after it to separate from.
 */
const renderCriterion = (criterion: Ticket["acceptanceCriteria"][number], position: number): readonly string[] => {
  const clauses = [
    `**GIVEN** ${criterion.given}`,
    `**WHEN** ${criterion.when}`,
    ...criterion.then.map((clause, index) => `**${index === 0 ? "THEN" : "AND"}** ${clause}`)
  ]
  return [
    `**AC.${String(position + 1).padStart(2, "0")} - ${criterion.title}**`,
    "",
    ...clauses.map((line, index) => (index === clauses.length - 1 ? line : `${line}&nbsp;`))
  ]
}

/** "Nothing" is a stated answer, never an omitted one: the standard asks the writer for it, and the body says it. */
const orNothing = (values: readonly string[]): string => (values.length > 0 ? values.join(", ") : "nothing")

export const renderTicketBody = (ticket: Ticket): string => {
  const lines: string[] = []

  if (ticket.graphNodes.length > 0) {
    lines.push(`GraphNodes: ${ticket.graphNodes.map((node) => `${node.marker} \`${node.name}\``).join(" ")}`, "")
  }

  lines.push("## Executive Summary", "", ticket.executiveSummary, "")
  lines.push(`**Type:** ${ticket.type}`)
  lines.push(`**Component:** ${ticket.component.map((entry) => `\`${entry}\``).join(", ")}`, "")
  lines.push("## Context", "", ticket.context, "")
  lines.push("## Acceptance Criteria", "")

  for (const [index, criterion] of ticket.acceptanceCriteria.entries()) {
    lines.push(...renderCriterion(criterion, index), "")
  }

  lines.push(`> Depends on: ${orNothing(ticket.dependsOn)} · Blocks: ${orNothing(ticket.blocks)}`)

  return lines.join("\n")
}
