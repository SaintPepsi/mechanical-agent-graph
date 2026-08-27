import type { Audience, ChecklistStep, CitationRoot, Concern, Section, TemplateSection } from "mag/skills/design/concern"
import { preamble } from "mag/skills/design/preamble"

/**
 * `preamble` is not one of a variant's listed concerns — it isn't one of the 13 core concerns, and
 * both layouts carry it identically — so it renders unconditionally, first, the same way
 * `## Checklist`'s frame is owned by this module rather than by any one concern.
 */

/** `templateSections` is authored separately from `concerns` rather than derived from the same list
 * order: a concern's checklist position and its template position are different facts about it (
 * `principles-stack` reads early, before approaches are proposed, but its "Principles Applied"
 * section records the outcome and belongs at the template's end; `design-doc-template` itself opens
 * the template with Problem/Constraints and closes it with Open Questions, a split no single list
 * position can reproduce). `A` states one variant's own audience once; `Concern<A | "any">` is the
 * gate on `concerns`, not a runtime filter: listing a concern of a different audience here is a
 * compile error at the list, in both directions. */
export interface Variant<A extends Audience = "headless"> {
  readonly citationRoot: CitationRoot
  readonly concerns: readonly Concern<A | "any">[]
  readonly templateSections: readonly TemplateSection[]
}

/** "## Checklist" heading and its one-line instruction: the frame the steps render into, not prose
 * about any one concern. Exported so `partition.test.ts` names the frame by import rather than by a
 * copy of its literal. */
export const CHECKLIST_HEADER = "## Checklist\n\nCreate a task for each item and complete in order:\n\n"

/** Renumbers 1..n from whatever steps survive, so a dropped concern never leaves a numbering gap to
 * maintain by hand. */
export const renderChecklist = (root: CitationRoot, steps: readonly ChecklistStep[]): string =>
  steps.map((step, index) => `${index + 1}. **${step.label(root)}** — ${step.tail}`).join("\n")

/** One concern's section, heading omitted when empty (the section continues the previous concern's
 * heading, e.g. `reference-sweep`'s paragraph under `seams-ownership`'s). Exported so
 * `partition.test.ts`'s owned-fragment lists render each section the same way the composer does. */
export const renderSection = (root: CitationRoot, section: Section): string =>
  section.heading === "" ? section.body(root) : `${section.heading}\n\n${section.body(root)}`

/** The design-doc template's frame. Composer-owned for the same reason the checklist header is:
 * every variant needs it, and it is no one concern's text. Exported so the partition test names the
 * frame by import rather than by a copy of its literals. */
export const TEMPLATE_FRAME = {
  header: "## Design Doc Template",
  fenceOpen: "```markdown\n# <Topic> — Design\n\n**Date:** YYYY-MM-DD",
  fenceClose: "```"
} as const

export const renderTemplate = (sections: readonly TemplateSection[]): string =>
  `${TEMPLATE_FRAME.header}\n\n${TEMPLATE_FRAME.fenceOpen}\n\n${
    sections.map((section) => `${section.heading}\n\n${section.body}`).join("\n\n")
  }\n${TEMPLATE_FRAME.fenceClose}\n\n`

/** `MAX_ARG_STRLEN` is the Linux `execve` argv cap: a shell command carrying an oversized prompt
 * dies at `execve`, with no size guard of ours in front of it. `assemble-brainstorm-prompt` runs
 * this composed prompt through a shell arg, so its budget is the same cap every other caller of
 * that seam dies against, not a number chosen for this node alone. */
export const MAX_ARG_STRLEN = 128 * 1024

/** A quarter of the argv cap: room for the rest of the command line (the shell invocation itself,
 * other flags) alongside the composed prompt, rather than the whole cap spent on this one string. */
export const COMPOSED_PROMPT_BUDGET = MAX_ARG_STRLEN / 4

/** UTF-8 byte length, not `.length` (a JS string's UTF-16 code-unit count) — the argv cap is bytes. */
export const promptBytes = (prompt: string): number => Buffer.byteLength(prompt, "utf8")

/** Pure: variant in, prompt out. No I/O, no dispatch-time facts, so a consuming node can compose
 * inside its own runtime and fill the tokens itself. Takes `Variant<Audience>`, the widest one: the
 * gate is on authoring a variant's list, and a composed document is past that gate. */
export const composeDesignPrompt = (variant: Variant<Audience>): string => {
  const root = variant.citationRoot
  const checklist = renderChecklist(root, variant.concerns.flatMap((concern) => concern.steps ?? []))
  const sections = variant.concerns
    .flatMap((concern) => (concern.section === undefined ? [] : [renderSection(root, concern.section)]))
    .join("")

  return renderSection(root, preamble.section) + `${CHECKLIST_HEADER}${checklist}\n\n` + sections +
    renderTemplate(variant.templateSections)
}
