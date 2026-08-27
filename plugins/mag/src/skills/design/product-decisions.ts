import type { Concern } from "mag/skills/design/concern"

/** This is the headless case: the section's own "when running autonomously, record it in Open
 * Questions" is the only autonomy instruction this section has ever had. Carried for every
 * audience, headless included. */
export const productDecisions: Concern<"any"> = {
  id: "product-decisions",
  audience: "any",
  section: {
    heading: "## What You May Decide vs What the User Sees",
    body: () =>
      `Pragmatic calls cover **how it's built** — structure, seams, placement, data flow. They never cover **what the user sees relative to what already exists**. If a choice would make an existing concept look or behave differently from how it renders today — dropping a label, changing an affordance, restyling a shared element — that is a product decision, not a design decision: ask the user, or when running autonomously, record it in Open Questions and **default to the existing behavior**. "The requirements don't mention it" argues **for** the status quo, never against it (principle: Same Concept, Same Rendering — silence in the ACs is not permission to diverge).\n\n`
  }
}
