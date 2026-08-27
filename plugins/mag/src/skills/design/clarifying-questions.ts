import type { ChecklistStep, Concern } from "mag/skills/design/concern"

export const STEP: ChecklistStep = { label: () => "Ask clarifying questions", tail: "one at a time, multiple-choice when possible" }

/** Interactive only: there is no question channel in a headless dispatch. `autonomy` takes this
 * step's slot in `HEADLESS_DESIGN`. The topic enumeration has no other home in the concern split,
 * so it becomes this concern's own `section` rather than being dropped. */
export const clarifyingQuestions: Concern<"interactive"> = {
  id: "clarifying-questions",
  audience: "interactive",
  steps: [STEP],
  section: {
    heading: "## Clarifying Questions",
    body: () => "Cover purpose, constraints, success criteria, performance requirements, and integration points.\n\n"
  }
}
