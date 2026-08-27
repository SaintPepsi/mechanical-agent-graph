import type { ChecklistStep, Concern } from "mag/skills/design/concern"

export const STEP: ChecklistStep = { label: () => "Explore project context", tail: "files, docs, recent commits, relevant types" }

/** A design that hasn't read the repo restates the ticket. Carried for every audience, headless
 * included. */
export const exploreContext: Concern<"any"> = {
  id: "explore-context",
  audience: "any",
  steps: [STEP]
}
