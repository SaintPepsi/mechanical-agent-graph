import type { Concern, TemplateSection } from "mag/skills/design/concern"

/** The template is the artifact contract that `write-pr-body` and `review-diff` both read. Carried
 * for every audience, headless included. The fence around it is composer-owned (`compose.ts`'s
 * `TEMPLATE_FRAME`), the same treatment `## Checklist` gets, since every variant needs it. */

/** Split around the sections other concerns own, so every variant can open the fence with
 * Problem/Constraints and close it with Open Questions last, without this concern's own block
 * sitting contiguous in the middle (`compose.ts`'s `Variant.templateSections`, `renderTemplate`).
 * Every variant needs the same split, because Problem/Constraints reads first and Open Questions
 * reads last regardless of audience. */
export const TEMPLATE_OPEN_SECTIONS: readonly TemplateSection[] = [
  { heading: "## Problem", body: "What we're solving and why." },
  { heading: "## Constraints", body: "Hard limits, deadlines, integration requirements." }
]
export const TEMPLATE_TAIL_SECTIONS: readonly TemplateSection[] = [
  { heading: "## Architecture", body: "Components, data shapes, flow." },
  { heading: "## Data Model", body: "Types, schemas, central definitions." },
  { heading: "## Error Handling", body: "Failure modes and responses." },
  { heading: "## Testing Strategy", body: "What gets tested at which layer (unit / integration / e2e)." }
]
export const TEMPLATE_OPEN_QUESTIONS: TemplateSection = { heading: "## Open Questions", body: "Anything unresolved." }

/** Carried for every audience. The section says only "scale each section to complexity": a list of
 * what to cover would just restate the template's own `##` headings, which the fenced template
 * below already renders. */
export const designDocTemplate: Concern<"any"> = {
  id: "design-doc-template",
  audience: "any",
  section: {
    heading: "## Presenting the Design",
    body: () => "Scale each section to complexity.\n\n"
  },
  templateSections: [...TEMPLATE_OPEN_SECTIONS, ...TEMPLATE_TAIL_SECTIONS, TEMPLATE_OPEN_QUESTIONS]
}
