import type { ChecklistStep, Concern } from "mag/skills/design/concern"

export const STEP: ChecklistStep = {
  label: () => "Propose 2-3 approaches",
  tail: "each evaluated against principles, with tradeoffs and recommendation"
}

/** The identical-rubric and no-verdicts rules are what stop deck-stacking. Carried for every
 * audience, headless included. */
export const approachesRubric: Concern<"any"> = {
  id: "approaches-rubric",
  audience: "any",
  steps: [STEP],
  section: {
    heading: "## Exploring Approaches",
    body: () =>
      `Remove unnecessary features — YAGNI ruthlessly. If you can't write a plausible **Wins when:** for an approach, it isn't a real option: replace it with one that is.\n\n`
  },
  templateSections: [
    {
      heading: "## Approaches Considered",
      body:
        `<!-- Identical rubric per approach. NO verdicts here — no "rejected", no "(recommended)";\n     the comparison happens in Chosen Approach, after all options are drawn in full. -->\n\n1. **Approach A** — summary, structure, principle implications, costs/risks. **Wins when:** …\n2. **Approach B** — summary, structure, principle implications, costs/risks. **Wins when:** …\n3. **Approach C** — summary, structure, principle implications, costs/risks. **Wins when:** …`
    },
    {
      heading: "## Chosen Approach",
      body:
        `The picked approach and why — including why each alternative's "Wins when:" condition\ndoesn't hold here. This is the only section where rejection language belongs.`
    }
  ]
}
