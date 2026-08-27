import type { Concern } from "mag/skills/design/concern"

/**
 * Without this concern, a silent reading of an ambiguous AC can reach build unaudited: the design
 * node's success value is `{ designPath, headSha, sessions, costUsd }`, so no reading travels
 * downstream unless the design doc itself records it.
 */
export const interpretationRulings: Concern<"any"> = {
  id: "interpretation-rulings",
  audience: "any",
  section: {
    heading: "## Interpretation Rulings",
    body: () =>
      "Every AC ambiguity you resolve is a recorded ruling, never a silent choice. Where the design commits to a reading of an AC whose wording allows more than one, the design doc's **Interpretation Rulings** section records the AC id, the chosen reading, and its basis. A ruling about user-visible behaviour with no basis in the ticket or its attachments is not yours to make — it goes under Open Questions instead.\n\n"
  },
  templateSections: [
    {
      heading: "## Interpretation Rulings",
      body:
        "Present when an AC's wording allows more than one reading. One row per ruling: the AC id, the chosen reading, and its basis.\n\n| AC | Reading | Basis |\n| --- | --- | --- |"
    }
  ]
}
