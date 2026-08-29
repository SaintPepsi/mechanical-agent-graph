import type { Concern } from "mag/skills/design/concern"

/** Carried for every audience, headless included: the section names both routes itself, a user to
 * ask and, autonomously, the existing behaviour kept as a recorded ruling, so no variant needs a
 * second copy of the product-decision rule. */
export const productDecisions: Concern<"any"> = {
  id: "product-decisions",
  audience: "any",
  section: {
    heading: "## What You May Decide vs What the User Sees",
    body: () =>
      `Pragmatic calls cover **how it's built**: structure, seams, placement, data flow. They never cover **what the user sees relative to what already exists**. If a choice would make an existing concept look or behave differently from how it renders today (dropping a label, changing an affordance, restyling a shared element), that is a product decision, not a design decision: ask the user, or when running autonomously, **keep the existing behavior** and record it under Interpretation Rulings with that as its basis. "The requirements don't mention it" argues **for** the status quo, never against it (principle: Same Concept, Same Rendering, silence in the ACs is not permission to diverge).\n\n`
  }
}
